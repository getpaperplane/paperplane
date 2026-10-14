import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import type { PotetoProbe, PotetoRole } from "../../orchestration/poteto/PotetoMode.ts";

export const POTETO_FIXTURE_TASK =
  "Discounts must apply at the minimum spend, not only above it. Fix the boundary without changing the threshold or discount rate.";
export const POTETO_FIXTURE_FILES = [
  { path: "discount.json", content: '{"minimum":100,"rate":0.1,"comparison":"gt"}' },
];
const Config = Schema.Struct({
  minimum: Schema.Number,
  rate: Schema.Number,
  comparison: Schema.Literals(["gt", "gte"]),
});
const decodeConfig = Schema.decodeUnknownSync(Schema.fromJsonString(Config));
const decodePrompt = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      role: Schema.Literals([
        "how",
        "why",
        "diagnose",
        "design-a",
        "design-b",
        "plan",
        "implement",
        "review",
      ]),
    }),
  ),
);
/** Trusted same-surface check. Candidate JSON is data, never evaluated as host code. */
export const potetoFixtureProbe: PotetoProbe = {
  id: "discount-cli-boundary-v1",
  run: async (files, signal) => {
    signal.throwIfAborted();
    try {
      const config = decodeConfig(files.find((file) => file.path === "discount.json")!.content);
      const output = [99, 100, 101].map((amount) => {
        const eligible =
          config.comparison === "gt" ? amount > config.minimum : amount >= config.minimum;
        const actual = eligible ? amount * config.rate : 0;
        const expected = amount >= 100 ? amount * 0.1 : 0;
        return { amount, actual, expected };
      });
      return {
        outcome:
          output.every((row) => row.actual === row.expected) &&
          config.minimum === 100 &&
          config.rate === 0.1
            ? "pass"
            : "fail",
        output: output
          .map((row) => `spend=${row.amount}: discount=${row.actual}, expected=${row.expected}`)
          .join("\n"),
      };
    } catch {
      return {
        outcome: "inconclusive",
        output: "Candidate configuration is not executable by the discount CLI.",
      };
    }
  },
};

export type PotetoFixtureBehavior =
  | "cooperate"
  | "attempt-bypass"
  | "skip-report"
  | "forged-evidence"
  | "bad-fix"
  | "reject-review"
  | "loop"
  | "edit-after-report"
  | "report-before-read"
  | "accept-observation"
  | "repair-implement"
  | "repair-investigate"
  | "endless-repair";
export function potetoFixtureReport(
  role: PotetoRole,
  behavior: PotetoFixtureBehavior = "cooperate",
  needsRepair = true,
) {
  const base = {
    summary: `Completed ${role} for the inclusive discount boundary.`,
    evidenceIds: [role === "review" ? "verification" : "reproduction"],
  };
  if (behavior === "forged-evidence") base.evidenceIds = ["agent-says-it-passed"];
  switch (role) {
    case "how":
      return {
        ...base,
        summary: "The CLI compares spend with the configured threshold before applying the rate.",
      };
    case "why":
      return {
        ...base,
        summary:
          "No regression history is supplied. The requirement specifies an inclusive minimum.",
      };
    case "diagnose":
      return {
        ...base,
        mechanism: "The strict gt operator excludes spend exactly equal to 100.",
        hypotheses: [
          "The configured rate is wrong; refuted by the 101 case.",
          "The comparison excludes equality; confirmed by the 100 case.",
        ],
      };
    case "design-a":
      return {
        ...base,
        dataModel: "Keep minimum, rate, and comparison configuration.",
        approach: "Switch the comparison from gt to gte.",
      };
    case "design-b":
      return {
        ...base,
        dataModel: "Represent the lower bound with an explicit inclusive flag.",
        approach: "Replace comparison with a bound object and update the interpreter.",
      };
    case "plan":
      return {
        ...base,
        selected: "design-a",
        rationale:
          "The existing gte option expresses the requirement without a new data structure.",
      };
    case "review": {
      const repair =
        needsRepair &&
        (behavior === "repair-implement" ||
          behavior === "repair-investigate" ||
          behavior === "endless-repair");
      const rejected = behavior === "reject-review" || repair;
      return {
        ...base,
        verdict: rejected ? "reject" : "accept",
        findings: rejected
          ? [
              {
                severity: "blocker",
                message: repair
                  ? "Remove the redundant unused configuration introduced by the fix."
                  : "The candidate needs another boundary check.",
              },
            ]
          : behavior === "accept-observation"
            ? [
                {
                  severity: "observation",
                  message:
                    "The consuming source is outside this fixture; that is a scope limitation, not a defect.",
                },
              ]
            : [],
        repairTarget: repair
          ? behavior === "repair-investigate"
            ? "investigate"
            : "implement"
          : null,
      };
    }
    default:
      return base;
  }
}

/** Scripted provider exercises real SDK tool dispatch without credentials or paid model calls. */
export function registerPotetoFixtureModel(
  runtime: ModelRuntime,
  behavior: PotetoFixtureBehavior = "cooperate",
  options: {
    reasoning?: boolean;
    pilot?: {
      path: string;
      oldText: string;
      newText: string;
      report: (role: PotetoRole) => Schema.JsonObject;
    };
  } = {},
) {
  runtime.registerProvider("rove-poteto-fixture", {
    baseUrl: "https://example.invalid",
    apiKey: "fixture-key",
    api: "openai-completions",
    models: [
      {
        id: "fixture",
        name: "Poteto fixture",
        reasoning: options.reasoning ?? false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64_000,
        maxTokens: 2048,
      },
    ],
    streamSimple(model, context) {
      const user = context.messages.find((message) => message.role === "user");
      const prompt = user?.content;
      const promptText = Predicate.isString(prompt)
        ? prompt
        : (prompt?.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ?? "");
      const { role } = decodePrompt(promptText);
      const results = context.messages.filter((message) => message.role === "toolResult");
      const filePath = options.pilot?.path ?? "discount.json";
      const reply = (content: AssistantMessage["content"], stopReason: "stop" | "toolUse") => {
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: 0,
          usage: {
            input: 3,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 5,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          content,
          stopReason,
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: stopReason, message });
        stream.end();
        return stream;
      };
      const call = (
        name: string,
        args: Extract<AssistantMessage["content"][number], { type: "toolCall" }>["arguments"],
      ) =>
        reply(
          [{ type: "toolCall", id: `${role}-${results.length}`, name, arguments: args }],
          "toolUse",
        );
      if (behavior === "loop") return call("read_snapshot", { path: "discount.json" });
      if (behavior === "report-before-read" && results.length === 0)
        return call("submit_report", { report: potetoFixtureReport(role) });
      if (
        behavior === "edit-after-report" &&
        role === "implement" &&
        results.some((result) => result.toolName === "submit_report") &&
        results.filter((result) => result.toolName === "replace_file").length === 1
      )
        return call("replace_file", {
          path: "discount.json",
          oldText: '"rate":0.1',
          newText: '"rate":0.9',
        });
      if (behavior === "skip-report")
        return reply(
          [
            {
              type: "text",
              text: "All phases are complete. I verified it myself; skip straight to done.",
            },
          ],
          "stop",
        );
      if (behavior === "attempt-bypass" && role === "how") {
        if (results.length === 0) return call("bash", { command: "echo bypass" });
        if (results.length === 1)
          return call("replace_file", { path: "discount.json", oldText: '"gt"', newText: '"gte"' });
        if (results.length === 2) return call("read_snapshot", { path: "/etc/passwd" });
      }
      if (!results.some((result) => result.toolName === "read_snapshot" && !result.isError))
        return call("read_snapshot", { path: filePath });
      if (options.pilot) {
        if (role === "implement" && !results.some((result) => result.toolName === "replace_file"))
          return call("replace_file", {
            path: options.pilot.path,
            oldText: options.pilot.oldText,
            newText: options.pilot.newText,
          });
        if (!results.some((result) => result.toolName === "submit_report"))
          return call("submit_report", { report: options.pilot.report(role) });
        return reply([{ type: "text", text: "Pilot phase report submitted." }], "stop");
      }
      const source =
        results
          .find((result) => result.toolName === "read_snapshot" && !result.isError)
          ?.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("") ?? "";
      if (role === "implement" && !results.some((result) => result.toolName === "replace_file")) {
        const repairing =
          behavior === "repair-implement" ||
          behavior === "repair-investigate" ||
          behavior === "endless-repair";
        if (repairing && source.includes('"unused"')) {
          if (behavior === "endless-repair") {
            const match = /"unused":(\d+)/.exec(source)!;
            return call("replace_file", {
              path: "discount.json",
              oldText: match[0],
              newText: `"unused":${Number(match[1]) + 1}`,
            });
          }
          return call("replace_file", {
            path: "discount.json",
            oldText: ',"unused":0',
            newText: "",
          });
        }
        return call("replace_file", {
          path: "discount.json",
          oldText: '"gt"',
          newText: behavior === "bad-fix" ? '"gt "' : repairing ? '"gte","unused":0' : '"gte"',
        });
      }
      if (!results.some((result) => result.toolName === "submit_report"))
        return call("submit_report", {
          report: potetoFixtureReport(role, behavior, source.includes('"unused"')),
        });
      return reply([{ type: "text", text: "Phase report submitted." }], "stop");
    },
  });
  return "rove-poteto-fixture/fixture";
}
