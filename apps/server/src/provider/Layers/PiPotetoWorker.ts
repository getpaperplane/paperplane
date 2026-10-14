// @effect-diagnostics nodeBuiltinImport:off - Runs alongside Pi SDK sessions, outside the Effect runtime.
import {
  createAgentSessionFromServices,
  DefaultResourceLoader,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as Schema from "effect/Schema";
import type { PiThinkingLevel } from "@rove-code/contracts";
import {
  decodePotetoFiles,
  POTETO_REPORTS,
  POTETO_REPORT_DECODERS,
  type PotetoRole,
  type PotetoWorker,
} from "../../orchestration/poteto/PotetoMode.ts";

/** Native callers may inherit preferences without loading any session resources. */
export function resolvePiPotetoThinkingLevel(
  modelRuntime: ModelRuntime,
  model: string,
  settings: SettingsManager,
  thinkingLevel?: PiThinkingLevel,
): PiThinkingLevel | undefined {
  const resolved = resolveCliModel({ cliModel: model, modelRuntime });
  return (
    resolved.thinkingLevel ??
    thinkingLevel ??
    (resolved.model &&
      settings.getModelThinkingLevel(resolved.model.provider, resolved.model.id)) ??
    settings.getDefaultThinkingLevel()
  );
}

const INSTRUCTIONS = {
  how: "Trace how the affected logic works. Explain the data flow and ownership from the snapshot and reproduction.",
  why: "Investigate the motivation and possible regression. Distinguish observable facts from unknown history; never invent history.",
  diagnose:
    "Compare at least two hypotheses against the reproduction and investigations. Describe the surviving mechanism, not a speculative fix.",
  "design-a":
    "Propose the smallest direct fix. Name the data shape and explain why it addresses the reproduced mechanism.",
  "design-b":
    "Independently propose a genuinely different design. Name the data shape, boundaries, and tradeoffs. Do not duplicate the direct fix.",
  plan: "Select design-a or design-b from the supplied alternatives. Explain the choice and constrain implementation to the reproduced bug.",
  implement:
    "Implement the accepted plan with replace_file. Make only the change justified by the reproduction. Do not change the check.",
  review:
    "Independently compare the original and candidate against the task, plan, and host check. Classify each finding as blocker (an evidenced defect or unmet acceptance criterion) or observation (advice or a limitation, not a defect). Accept with observations when no blockers remain. On rejection, choose repairTarget implement or investigate only if those workers can address the blockers within the supplied file scope; otherwise use null. Do not demand speculative changes just because more evidence could exist.",
} satisfies Record<PotetoRole, string>;
const ReadInput = Schema.Struct({ path: Schema.String });
const ReplaceInput = Schema.Struct({
  path: Schema.String,
  oldText: Schema.String.check(Schema.isNonEmpty()),
  newText: Schema.String,
});
const decodeReadInput = Schema.decodeUnknownSync(ReadInput);
const decodeReplaceInput = Schema.decodeUnknownSync(ReplaceInput);
const decodeSubmitInput = Schema.decodeUnknownSync(Schema.Struct({ report: Schema.Unknown }));

/** Fresh, extension-free sessions with no filesystem, shell, MCP, or delegation tools.
 * Workers edit a bounded in-memory snapshot, never the workspace or journal.
 * This is a capability boundary for model tool calls, not an OS sandbox for untrusted providers.
 */
export function createPiPotetoWorker(options: {
  readonly cwd: string;
  readonly agentDir: string;
  readonly modelRuntime: ModelRuntime;
  readonly model: string;
  readonly thinkingLevel?: PiThinkingLevel | undefined;
  readonly timeoutMs?: number;
  readonly onSession?: (session: AgentSession, role: PotetoRole) => void;
}): PotetoWorker {
  return async (request) => {
    request.signal.throwIfAborted();
    const resolved = resolveCliModel({
      cliModel: options.model,
      modelRuntime: options.modelRuntime,
    });
    if (!resolved.model || resolved.error)
      throw new Error(resolved.error ?? "Unknown Poteto Mode model.");
    const files = decodePotetoFiles(request.files).map((file) => ({ ...file }));
    const readPaths = new Set<string>();
    let report: unknown;
    let submitted = false;
    let toolCalls = 0;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      request.signal,
      controller.signal,
      AbortSignal.timeout(options.timeoutMs ?? 60_000),
    ]);
    const systemPrompt = [
      "You are a worker in Rove's native Poteto Mode prototype. You own only your assigned phase.",
      INSTRUCTIONS[request.role],
      "Read the snapshot before reporting. Submit your result with submit_report. Free-text claims do not advance the workflow.",
      "Cite reproduction evidence; review must cite verification. Stop after submitting. Tool access is controlled by Rove, not these instructions.",
    ].join("\n");
    const prompt = JSON.stringify({
      role: request.role,
      task: request.task,
      paths: files.map((file) => file.path),
      editablePaths: request.editablePaths ?? files.map((file) => file.path),
      context: request.context,
    });
    if (prompt.length > 48_000) throw new Error("Phase exceeds the prototype's context budget.");
    const guard = () => {
      signal.throwIfAborted();
      if (submitted) throw new Error("Phase report already submitted.");
      if (++toolCalls > 24) {
        controller.abort(new Error("Phase tool budget exhausted."));
        signal.throwIfAborted();
      }
    };
    const text = (value: string) => ({
      content: [{ type: "text" as const, text: value }],
      details: {},
    });
    const tools: ToolDefinition[] = [
      {
        name: "read_snapshot",
        label: "Read snapshot",
        description:
          "Read one approved snapshot file. Paths are opaque keys, not filesystem paths.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
        execute: async (_id, input) => {
          guard();
          const { path } = decodeReadInput(input);
          const file = files.find((entry) => entry.path === path);
          if (!file) throw new Error("Path is outside the approved snapshot.");
          readPaths.add(path);
          return text(file.content);
        },
      },
      {
        name: "submit_report",
        label: "Submit phase report",
        description:
          "Submit this phase's structured report. This does not complete or advance the workflow.",
        parameters: {
          type: "object",
          properties: { report: Schema.toJsonSchemaDocument(POTETO_REPORTS[request.role]).schema },
          required: ["report"],
          additionalProperties: false,
        },
        execute: async (_id, input) => {
          guard();
          if (readPaths.size === 0)
            throw new Error("Read the approved snapshot before submitting a report.");
          report = POTETO_REPORT_DECODERS[request.role](decodeSubmitInput(input).report);
          submitted = true;
          return text("Report received. Rove will validate it; stop now.");
        },
      },
    ];
    if (request.role === "implement") {
      tools.push({
        name: "replace_file",
        label: "Edit candidate snapshot",
        description:
          "Replace a unique exact match in an approved file already read in this phase. Does not write to disk.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            oldText: { type: "string", minLength: 1 },
            newText: { type: "string" },
          },
          required: ["path", "oldText", "newText"],
          additionalProperties: false,
        },
        execute: async (_id, input) => {
          guard();
          const { path, oldText, newText } = decodeReplaceInput(input);
          const file = files.find((entry) => entry.path === path);
          if (!file || !readPaths.has(path))
            throw new Error("Edit requires an approved file read in this phase.");
          if (request.editablePaths && !request.editablePaths.includes(path))
            throw new Error("Cannot edit a read-only context file.");
          const index = file.content.indexOf(oldText);
          if (index < 0 || file.content.indexOf(oldText, index + 1) >= 0)
            throw new Error("Edit must match a unique region.");
          const content =
            file.content.slice(0, index) + newText + file.content.slice(index + oldText.length);
          const candidate = files.map((entry) => (entry === file ? { path, content } : entry));
          decodePotetoFiles(candidate);
          files.splice(0, files.length, ...candidate);
          return text("Candidate snapshot updated.");
        },
      });
    }
    const settingsManager = SettingsManager.inMemory({
      defaultTools: [],
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: options.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => systemPrompt,
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();
    signal.throwIfAborted();
    const { session } = await createAgentSessionFromServices({
      services: {
        cwd: options.cwd,
        agentDir: options.agentDir,
        settingsManager,
        resourceLoader,
        modelRuntime: options.modelRuntime,
        diagnostics: [],
      },
      sessionManager: SessionManager.inMemory(options.cwd),
      model: resolved.model,
      tools: tools.map((tool) => tool.name),
      customTools: tools,
      thinkingLevel: resolved.thinkingLevel ?? options.thinkingLevel ?? "low",
    });
    // Check before dispatch, not after a response has already spent another call.
    // The conservative character cap is not an exact tokenizer. Overflow blocks
    // the phase instead of compacting away required artifacts.
    const contextLimit = Math.min(64_000, Math.floor(resolved.model.contextWindow / 2));
    let modelCalls = 0;
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = (model, context, streamOptions) => {
      signal.throwIfAborted();
      if (++modelCalls > 12) controller.abort(new Error("Phase model-turn budget exhausted."));
      if (JSON.stringify(context).length > contextLimit)
        controller.abort(new Error("Phase context budget exhausted."));
      signal.throwIfAborted();
      return stream(model, context, streamOptions);
    };
    let failure: string | undefined;
    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        (event.message.stopReason === "error" || event.message.stopReason === "aborted")
      )
        failure = event.message.errorMessage ?? "Phase worker stopped.";
    });
    const abort = () => {
      void session.abort();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      options.onSession?.(session, request.role);
      signal.throwIfAborted();
      await session.prompt(prompt, { expandPromptTemplates: false });
      signal.throwIfAborted();
      if (failure) throw new Error(failure);
      if (!submitted) throw new Error("Worker ended without a structured phase report.");
      return {
        report,
        files,
        readPaths: [...readPaths],
        execution: {
          model: `${session.model?.provider}/${session.model?.id}`,
          thinkingLevel: session.thinkingLevel,
        },
      };
    } finally {
      signal.removeEventListener("abort", abort);
      unsubscribe();
      await session.abort();
      session.dispose();
    }
  };
}
