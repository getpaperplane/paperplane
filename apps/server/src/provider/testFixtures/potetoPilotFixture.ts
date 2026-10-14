import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type * as Schema from "effect/Schema";
import type { PotetoRole } from "../../orchestration/poteto/PotetoMode.ts";
import { registerPotetoFixtureModel } from "./potetoFixture.ts";

/** Known edit for testing the included pilot's plumbing, never a generic coding agent. */
const POTETO_PILOT_SCRIPTED_EDIT = {
  path: "packages/shared/src/String.ts",
  oldText: "  return `${trimmed.slice(0, maxLength)}...`;",
  newText:
    '  const limit = Math.max(0, maxLength);\n  const suffix = ".".repeat(Math.min(3, limit));\n  return `${trimmed.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;',
};
export function potetoPilotFixtureReport(role: PotetoRole): Schema.JsonObject {
  const base = {
    summary: `Completed ${role} for the truncate hard-length boundary.`,
    evidenceIds: [role === "review" ? "verification" : "reproduction"],
  };
  switch (role) {
    case "how":
      return {
        ...base,
        summary:
          "truncate trims input, keeps short strings intact, and currently appends three dots after taking maxLength characters.",
      };
    case "why":
      return {
        ...base,
        summary: "The task requires a hard output bound. No regression history is supplied.",
      };
    case "diagnose":
      return {
        ...base,
        mechanism: "The ellipsis is appended outside the maxLength budget.",
        hypotheses: [
          "Trimming is wrong; the short trimmed case passes.",
          "The ellipsis exceeds the budget; boundary outputs demonstrate the extra dots.",
        ],
      };
    case "design-a":
      return {
        ...base,
        dataModel: "Keep the string input and numeric maxLength contract.",
        approach:
          "Reserve up to three characters for dots, then slice within the remaining budget.",
      };
    case "design-b":
      return {
        ...base,
        dataModel: "Keep the same function signature.",
        approach: "Build a truncated candidate and clamp the entire output as a final step.",
      };
    case "plan":
      return {
        ...base,
        selected: "design-a",
        rationale: "Reserve the suffix explicitly so short limits also respect the hard bound.",
      };
    case "review":
      return { ...base, verdict: "accept", findings: [], repairTarget: null };
    default:
      return base;
  }
}
export function registerPotetoPilotFixtureModel(runtime: ModelRuntime) {
  return registerPotetoFixtureModel(runtime, "cooperate", {
    pilot: { ...POTETO_PILOT_SCRIPTED_EDIT, report: potetoPilotFixtureReport },
  });
}
