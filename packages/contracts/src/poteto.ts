import * as Schema from "effect/Schema";
import { CommandId } from "./baseSchemas.ts";

const BoundedPath = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096));
const JsonCases = Schema.Struct({
  args: Schema.Array(Schema.Json),
  expected: Schema.Json,
});

/** The bounded, repo-relative project/check definition accepted by the Poteto pilot. */
export const PotetoProjectSpec = Schema.Struct({
  task: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
  editableFiles: Schema.Array(BoundedPath).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  contextFiles: Schema.Array(BoundedPath).check(Schema.isMaxLength(16)),
  check: Schema.Struct({
    module: BoundedPath,
    export: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
    cases: Schema.Array(JsonCases).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  }),
});
export type PotetoProjectSpec = typeof PotetoProjectSpec.Type;

export const PotetoDraftResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("draft"), spec: PotetoProjectSpec }),
  Schema.Struct({
    status: Schema.Literal("unsupported"),
    reason: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
  }),
]);
export type PotetoDraftResult = typeof PotetoDraftResult.Type;

const POTETO_PHASES = [
  "reproduce",
  "investigate",
  "design",
  "implement",
  "verify",
  "review",
] as const;
export const PotetoPhase = Schema.Literals(POTETO_PHASES);
export type PotetoPhase = typeof PotetoPhase.Type;

const PotetoProgressStatus = Schema.Literals([
  "requested",
  "running",
  "blocked",
  "interrupted",
  "cancelled",
  "candidate-ready",
]);
export type PotetoProgressStatus = typeof PotetoProgressStatus.Type;

const OptionalBoundedString = (maxLength: number) =>
  Schema.optional(Schema.String.check(Schema.isMaxLength(maxLength)));

export const PotetoProgress = Schema.Struct({
  runId: CommandId,
  attemptId: CommandId,
  status: PotetoProgressStatus,
  phase: Schema.NullOr(PotetoPhase),
  reason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))),
  baseCommit: OptionalBoundedString(256),
  revision: OptionalBoundedString(256),
  patch: OptionalBoundedString(32_768),
});
export type PotetoProgress = typeof PotetoProgress.Type;

/** Latest valid progress row on a Poteto activity; legacy/unrelated rows are ignored. */
export function latestThreadPotetoProgress(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): PotetoProgress | undefined {
  const decodePayload = Schema.decodeUnknownOption(Schema.Struct({ progress: Schema.Unknown }));
  const decodeProgress = Schema.decodeUnknownOption(PotetoProgress);
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (!activity.kind.startsWith("poteto.")) continue;
    const payload = decodePayload(activity.payload);
    if (payload._tag === "None") continue;
    const progress = decodeProgress(payload.value.progress);
    if (progress._tag === "Some") return progress.value;
  }
  return undefined;
}

export const PotetoActivityKind = Schema.Literals([
  "poteto.requested",
  "poteto.control",
  "poteto.event",
  "poteto.finished",
]);
export type PotetoActivityKind = typeof PotetoActivityKind.Type;

export const isPotetoActivity = Schema.is(PotetoActivityKind);
