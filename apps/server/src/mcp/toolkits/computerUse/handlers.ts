import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";

import {
  applyBackgroundPolicy,
  instructionsFor,
  isolatedRefusal,
  isAllowedTool,
  offSpaceNote,
} from "../../../computerUse/BackgroundPolicy.ts";
import * as CuaDriver from "../../../computerUse/CuaDriver.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ComputerUseToolkit } from "./tools.ts";

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const textResult = (text: string, isError = false) =>
  new McpSchema.CallToolResult({ isError, content: [{ type: "text", text }] });

const MAX_STRUCTURED_TEXT_CHARS = 24_000;

/**
 * Cua returns window ids, snapshot ids, and element lists only in
 * `structuredContent`, with a one-line summary as text. Pi and other clients
 * show the model only the text, so repeat the structured data there, bounded
 * below Claude Code's result limit.
 */
const withStructuredText = (result: McpSchema.CallToolResult) => {
  const structured = result.structuredContent;
  if (
    structured === undefined ||
    structured === null ||
    (typeof structured === "object" && Object.keys(structured).length === 0)
  ) {
    return result;
  }
  const json = encodeJsonText(structured);
  const text =
    json.length > MAX_STRUCTURED_TEXT_CHARS
      ? `${json.slice(0, MAX_STRUCTURED_TEXT_CHARS)}…\nStructured result cut at ${MAX_STRUCTURED_TEXT_CHARS} characters. Narrow the call, for example with pid, window_id, query, or max_elements.`
      : json;
  return new McpSchema.CallToolResult({
    ...result,
    content: [...result.content, { type: "text", text: `Structured result:\n${text}` }],
  });
};

const summary = (description: string) => {
  const firstLine = description.split("\n", 1)[0] ?? "";
  const sentence = /^.*?[.!?](?=\s|$)/.exec(firstLine)?.[0] ?? firstLine;
  return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence;
};

const backgroundInputSchema = (schema: CuaDriver.CuaTool["inputSchema"]) => {
  const normalized = { ...schema };
  if (schema.properties) {
    normalized.properties = Object.fromEntries(
      Object.entries(schema.properties).filter(([name]) => name !== "session"),
    );
  }
  if (schema.required) normalized.required = schema.required.filter((name) => name !== "session");
  return normalized;
};

const policyRefusalResult = (reason: string, policy: CuaDriver.CuaCatalog["policy"]) =>
  new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      code: policy === "background-only" ? "background_only" : "isolated_desktop_policy",
      effect: "refused",
      executed: false,
      reason,
    },
    content: [
      {
        type: "text",
        text:
          policy === "background-only"
            ? `${reason} No action was executed. Retry with a background window action or use an app API. For web pages, use preview_*. If no safe route exists, continue other work and report the GUI step as blocked. Do not retry through foreground input or shell automation.`
            : `${reason} No action was executed. Use an allowed private-desktop operation. Paperplane owns sessions and target selection. Do not retry against the host desktop.`,
      },
    ],
  });

const make = Effect.gen(function* () {
  const driver = yield* CuaDriver.CuaDriver;
  const settings = yield* ServerSettings.ServerSettingsService;

  /** Read on every call so turning the setting off stops agents mid-session. */
  const whenEnabled = <E, R>(effect: Effect.Effect<McpSchema.CallToolResult, E, R>) =>
    settings.getSettings.pipe(
      Effect.map((current) => current.enableAgentComputerUse),
      Effect.orElseSucceed(() => false),
      Effect.flatMap((enabled) =>
        enabled
          ? effect
          : Effect.succeed(
              textResult(
                "Computer use is off for this environment. Ask the user to turn on Agent computer use in Settings → Integrations.",
                true,
              ),
            ),
      ),
    );

  const unavailable = (error: CuaDriver.CuaDriverUnavailableError) =>
    Effect.succeed(textResult(error.detail, true));

  return {
    computer_describe: McpToolAccess.readsAsCaller((input) =>
      whenEnabled(
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          return yield* driver.catalog(scope.thread?.threadId);
        }).pipe(
          Effect.map((catalog) => {
            const instructions = instructionsFor(catalog.policy, catalog.platform);
            if (input.tool == null) {
              const operations = catalog.tools
                .filter((tool) => isAllowedTool(tool, catalog.policy))
                .map((tool) => `- ${tool.name}: ${summary(tool.description)}`)
                .join("\n");
              return textResult(
                `${instructions}\n\n${catalog.instructions ?? ""}\n\nOperations (run with computer_call):\n${operations}`.trim(),
              );
            }
            const tool = catalog.tools.find((candidate) => candidate.name === input.tool);
            if (!tool)
              return textResult(
                `Cua Driver has no operation named ${input.tool}. Call computer_describe without arguments to list them.`,
                true,
              );
            if (!isAllowedTool(tool, catalog.policy))
              return policyRefusalResult(
                `${tool.name} is not an allowed ${catalog.policy} operation.`,
                catalog.policy,
              );
            return textResult(
              encodeJsonText({
                name: tool.name,
                description: `${instructions}\n\n${tool.description}`,
                inputSchema: backgroundInputSchema(tool.inputSchema),
              }),
            );
          }),
          Effect.catchTags({ CuaDriverUnavailableError: unavailable }),
        ),
      ),
    ),
    computer_call: McpToolAccess.actsAsCaller((input) =>
      whenEnabled(
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const invocation = yield* McpInvocationContext.requireThreadScope(scope, "Computer use");
          const catalog = yield* driver.catalog(invocation.thread.threadId);
          const tool = catalog.tools.find((candidate) => candidate.name === input.tool);
          if (!tool)
            return textResult(
              `Cua Driver has no operation named ${input.tool}. Call computer_describe without arguments to list them.`,
              true,
            );
          const requested = input.arguments ?? {};
          let args = requested;
          if (catalog.policy === "isolated-desktop") {
            const refusal = isolatedRefusal(tool, requested);
            if (refusal) return policyRefusalResult(refusal, catalog.policy);
          } else {
            const allowPixelInput = yield* settings.getSettings.pipe(
              Effect.map((current) => current.computerUseAllowPixelInput),
              Effect.orElseSucceed(() => false),
            );
            const decision = applyBackgroundPolicy(tool, requested, { allowPixelInput });
            if (decision.refusal !== undefined)
              return policyRefusalResult(decision.refusal, catalog.policy);
            args = decision.args;
          }
          const result = yield* driver
            .call(tool.name, args, invocation.thread.threadId, catalog.policy)
            .pipe(Effect.map(withStructuredText));
          if (catalog.policy !== "background-only" || (catalog.platform ?? "darwin") !== "darwin")
            return result;
          const note = offSpaceNote({
            isError: result.isError,
            text: result.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n"),
            structured: result.structuredContent,
          });
          return note === undefined
            ? result
            : new McpSchema.CallToolResult({
                ...result,
                content: [...result.content, { type: "text", text: note }],
              });
        }).pipe(Effect.catchTags({ CuaDriverUnavailableError: unavailable })),
      ),
    ),
  } satisfies McpToolAccess.Handlers<typeof ComputerUseToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(ComputerUseToolkit, make);
