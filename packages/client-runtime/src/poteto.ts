import * as Schema from "effect/Schema";
import {
  latestThreadPotetoProgress,
  PotetoPhase as PotetoPhaseSchema,
  PotetoProjectSpec as PotetoProjectSpecSchema,
  type OrchestrationThreadActivity,
  type PotetoProgress,
  type PotetoProjectSpec,
} from "@rove-code/contracts";

/** Empty thread creation records a checkout; it cannot create or switch one. */
export function resolvePotetoDraftWorkspace(input: {
  readonly workspaceMode: "local" | "worktree";
  readonly branch: string | null;
  readonly currentBranch: string | null;
  readonly worktreePath: string | null;
}) {
  if (input.workspaceMode === "worktree" && !input.worktreePath) {
    return {
      valid: false as const,
      reason: "Poteto Mode needs an existing checkout. Choose Local or an existing worktree first.",
    };
  }
  if (!input.worktreePath && input.branch && input.branch !== input.currentBranch) {
    return {
      valid: false as const,
      reason:
        "Check out the selected branch first, or choose the current branch. Poteto Mode runs from committed HEAD without switching branches.",
    };
  }
  return {
    valid: true as const,
    branch: input.worktreePath ? input.branch : input.currentBranch,
    worktreePath: input.worktreePath,
  };
}

export type PotetoProjectSpecValidation =
  | { readonly valid: true; readonly spec: PotetoProjectSpec }
  | { readonly valid: false; readonly errors: ReadonlyArray<string> };

export const POTETO_PROJECT_SPEC_EXAMPLE = JSON.stringify(
  {
    task: "Make truncate's maxLength a hard upper bound on the returned string, including the ellipsis. Preserve trimming and return short strings unchanged. For limits below three, use only as many dots as fit. The supported limits in this pilot are non-negative integers.",
    editableFiles: ["packages/shared/src/String.ts"],
    contextFiles: [],
    check: {
      module: "packages/shared/src/String.ts",
      export: "truncate",
      cases: [
        { args: ["  hello  ", 8], expected: "hello" },
        { args: ["abcdefghij", 8], expected: "abcde..." },
        { args: ["abcdefghij", 3], expected: "..." },
        { args: ["abcdefghij", 2], expected: ".." },
        { args: ["abc", 0], expected: "" },
      ],
    },
  },
  null,
  2,
);

const MAX_SPEC_BYTES = 24_000;
const SAFE_ARTIFACT_KEYS = new Set([
  "summary",
  "evidenceIds",
  "mechanism",
  "hypotheses",
  "dataModel",
  "approach",
  "selected",
  "rationale",
  "verdict",
  "findings",
  "repairTarget",
  "id",
  "checkId",
  "revision",
  "outcome",
  "output",
  "content",
  "type",
  "phase",
  "reason",
  "result",
  "totalFiles",
  "truncated",
  "report",
  "how",
  "why",
  "diagnosis",
  "design-a",
  "design-b",
  "plan",
  "implement",
  "reproduction",
  "verification",
]);
const decodeProjectSpec = Schema.decodeUnknownSync(PotetoProjectSpecSchema);
const decodeJson = Schema.decodeUnknownOption(Schema.Json);
const decodePhase = Schema.decodeUnknownOption(PotetoPhaseSchema);
const decodeProgress = latestThreadPotetoProgress;

function jsonObject(value: Schema.Json | undefined): Schema.JsonObject | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  // SAFETY: The input is already decoded JSON; excluding null and arrays leaves a JSON object.
  return value as Schema.JsonObject;
}

function isLiteralRepoPath(value: string): boolean {
  if (value.length > 4096 || value.startsWith("/") || /[\\\0\t\r\n:,]/.test(value)) return false;
  return !value
    .split("/")
    .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git");
}

/** Client-side feedback for the pilot form; the server remains authoritative. */
export function validatePotetoProjectSpecJson(source: string): PotetoProjectSpecValidation {
  if (source.length > MAX_SPEC_BYTES) {
    return { valid: false, errors: ["Spec exceeds the 24,000-character pilot limit."] };
  }

  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? `Invalid JSON: ${error.message}` : "Invalid JSON."],
    };
  }

  let spec: PotetoProjectSpec;
  try {
    spec = decodeProjectSpec(input);
  } catch (error) {
    return {
      valid: false,
      errors: [
        `Spec does not match the project/check schema: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  const paths = [...spec.editableFiles, ...spec.contextFiles];
  const errors: string[] = [];
  if (![...paths, spec.check.module].every(isLiteralRepoPath)) {
    errors.push("File scope must use literal, repo-relative paths without traversal or .git.");
  }
  if (paths.length > 16 || new Set(paths).size !== paths.length) {
    errors.push("The approved file scope must contain 1–16 distinct paths.");
  }
  if (!paths.includes(spec.check.module)) {
    errors.push("Check module must be included in editable or context files.");
  }
  if (!/\.(?:[cm]?js|[cm]?ts)$/.test(spec.check.module)) {
    errors.push("Checks support dependency-free JavaScript or TypeScript modules only.");
  }
  if (JSON.stringify(spec).length > MAX_SPEC_BYTES) {
    errors.push("Spec exceeds the 24,000-character pilot limit.");
  }
  return errors.length > 0 ? { valid: false, errors } : { valid: true, spec };
}

function sanitizeArtifact(value: Schema.Json, depth = 0): Schema.Json | undefined {
  if (depth > 5) return undefined;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return typeof value === "string" ? value.slice(0, 1200) : value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 8)
      .map((entry) => sanitizeArtifact(entry, depth + 1))
      .filter((entry): entry is Schema.Json => entry !== undefined);
  }
  const record = jsonObject(value);
  if (!record) return undefined;
  const safe: Record<string, Schema.Json> = {};
  for (const [key, entry] of Object.entries(record).slice(0, 20)) {
    if (!SAFE_ARTIFACT_KEYS.has(key)) continue;
    const sanitized = sanitizeArtifact(entry, depth + 1);
    if (sanitized !== undefined) safe[key] = sanitized;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

export interface PotetoActivityArtifact {
  readonly id: string;
  readonly phase: PotetoProgress["phase"];
  readonly artifact: Schema.JsonObject;
}

export interface ThreadPotetoView {
  readonly progress: PotetoProgress | null;
  readonly pending: boolean;
  readonly artifacts: ReadonlyArray<PotetoActivityArtifact>;
}

/** Keeps earlier reports for the latest run, while excluding file snapshots and other large data. */
export function deriveThreadPotetoView(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ThreadPotetoView {
  const progress = decodeProgress(activities) ?? null;
  if (!progress) return { progress: null, pending: false, artifacts: [] };
  const pending = !activities.some((activity) => {
    if (activity.kind !== "poteto.finished") return false;
    const decoded = decodeJson(activity.payload);
    if (decoded._tag === "None") return false;
    const payload = jsonObject(decoded.value);
    const finished = payload ? jsonObject(payload.progress) : null;
    return finished?.runId === progress.runId && finished.attemptId === progress.attemptId;
  });

  const artifacts: PotetoActivityArtifact[] = [];
  for (const activity of activities) {
    if (!activity.kind.startsWith("poteto.")) continue;
    const decodedPayload = decodeJson(activity.payload);
    if (decodedPayload._tag === "None") continue;
    const payload = jsonObject(decodedPayload.value);
    const activityProgress = payload ? jsonObject(payload.progress) : null;
    if (!payload || !activityProgress || activityProgress.runId !== progress.runId) continue;
    const rawArtifact = payload.artifact;
    if (rawArtifact === undefined) continue;
    const safeArtifact = sanitizeArtifact(rawArtifact);
    const artifact = safeArtifact === undefined ? null : jsonObject(safeArtifact);
    if (!artifact) continue;
    if (artifact.result === undefined && artifact.reason === undefined) continue;
    const decodedPhase = decodePhase(artifact.phase ?? activityProgress.phase);
    artifacts.push({
      id: activity.id,
      phase: decodedPhase._tag === "Some" ? decodedPhase.value : null,
      artifact,
    });
  }
  return { progress, pending, artifacts };
}

/** Short, human-readable teaser for the report row; never includes raw execution output. */
export function potetoArtifactPreview(artifact: Schema.JsonObject): string | null {
  const queue: Schema.Json[] = [artifact];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current === null || Array.isArray(current)) continue;
    const record = jsonObject(current);
    if (!record) continue;
    for (const key of ["summary", "outcome", "verdict"]) {
      const text = record[key];
      if (typeof text === "string") return text;
    }
    for (const key of SAFE_ARTIFACT_KEYS) {
      const nested = record[key];
      if (nested !== undefined && nested !== null && typeof nested === "object") {
        if (Array.isArray(nested)) queue.push(...nested.slice(0, 8));
        else queue.push(nested);
      }
    }
  }
  return null;
}
