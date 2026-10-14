import {
  CommandId,
  ModelSelection,
  PotetoProgress,
  PotetoProjectSpec,
  ProviderInstanceId,
  ProviderOptionSelection,
  TrimmedNonEmptyString,
  type OrchestrationThread,
  type PotetoProgress as PotetoProgressType,
  type PotetoProjectSpec as PotetoProjectSpecType,
} from "@rove-code/contracts";
import * as Schema from "effect/Schema";
import { decodePotetoEvents, replayPotetoMode } from "./PotetoMode.ts";

const CanonicalModelSelection = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optional(Schema.Array(ProviderOptionSelection)),
});
const RequestedPayload = Schema.Struct({
  runId: CommandId,
  attemptId: CommandId,
  spec: PotetoProjectSpec,
  modelSelection: CanonicalModelSelection,
  progress: PotetoProgress,
});
const PotetoRecordPayload = Schema.Struct({
  runId: CommandId,
  attemptId: CommandId,
  progress: PotetoProgress,
  event: Schema.optional(Schema.Unknown),
  action: Schema.optional(Schema.Literals(["cancel", "retry"])),
});
const decodeRequested = Schema.decodeUnknownOption(RequestedPayload);
const decodeRecord = Schema.decodeUnknownOption(PotetoRecordPayload);

export const MAX_POTETO_CORE_EVENTS = 64;
// Also bound retries that fail before producing any core events.
export const MAX_POTETO_ATTEMPTS = 16;

export interface ThreadPotetoRun {
  readonly runId: CommandId;
  readonly attemptId: CommandId;
  readonly spec: PotetoProjectSpecType;
  readonly modelSelection: ModelSelection;
  readonly events: ReadonlyArray<unknown>;
  readonly attemptCount: number;
  readonly progress: PotetoProgressType;
}

function recordFor(activity: OrchestrationThread["activities"][number]) {
  if (!activity.kind.startsWith("poteto.")) return undefined;
  const decoded = decodeRecord(activity.payload);
  return decoded._tag === "Some" ? decoded.value : undefined;
}

/** Rebuilds the currently-owned Poteto attempt and its compact core journal from activities. */
export function readThreadPotetoRun(
  thread: Pick<OrchestrationThread, "activities">,
): ThreadPotetoRun | undefined {
  let requested:
    | {
        readonly runId: CommandId;
        readonly attemptId: CommandId;
        readonly spec: PotetoProjectSpecType;
        readonly modelSelection: ModelSelection;
      }
    | undefined;
  for (let index = thread.activities.length - 1; index >= 0; index -= 1) {
    const activity = thread.activities[index]!;
    if (activity.kind !== "poteto.requested") continue;
    const decoded = decodeRequested(activity.payload);
    if (decoded._tag === "None") continue;
    const payload = decoded.value;
    if (
      payload.progress.runId !== payload.runId ||
      payload.progress.attemptId !== payload.attemptId
    )
      continue;
    requested = {
      runId: payload.runId,
      attemptId: payload.attemptId,
      spec: payload.spec,
      modelSelection: {
        instanceId: payload.modelSelection.instanceId,
        model: payload.modelSelection.model,
        ...(payload.modelSelection.options !== undefined
          ? { options: payload.modelSelection.options }
          : {}),
      },
    };
    break;
  }
  if (!requested) return undefined;

  let attemptId = requested.attemptId;
  let progress: PotetoProgressType | undefined;
  const events: unknown[] = [];
  const attempts = new Set<CommandId>();
  for (const activity of thread.activities) {
    const payload = recordFor(activity);
    if (!payload || payload.runId !== requested.runId) continue;
    if (
      payload.progress.runId !== payload.runId ||
      payload.progress.attemptId !== payload.attemptId
    )
      continue;
    attemptId = payload.attemptId;
    attempts.add(attemptId);
    progress = {
      ...(progress?.baseCommit !== undefined ? { baseCommit: progress.baseCommit } : {}),
      ...(progress?.revision !== undefined ? { revision: progress.revision } : {}),
      ...payload.progress,
    };
    if (activity.kind === "poteto.event" && payload.event !== undefined) {
      events.push(payload.event);
    }
  }

  return {
    ...requested,
    attemptId,
    events,
    attemptCount: attempts.size,
    progress: progress ?? {
      runId: requested.runId,
      attemptId: requested.attemptId,
      status: "requested",
      phase: null,
      reason: null,
    },
  };
}

/** A run stays locked until the current attempt has a durable finished row. */
export function isThreadPotetoActive(thread: Pick<OrchestrationThread, "activities">): boolean {
  const run = readThreadPotetoRun(thread);
  if (!run) return false;
  for (let index = thread.activities.length - 1; index >= 0; index -= 1) {
    const activity = thread.activities[index]!;
    if (activity.kind !== "poteto.finished") continue;
    const payload = recordFor(activity);
    if (
      payload?.runId === run.runId &&
      payload.attemptId === run.attemptId &&
      payload.progress.runId === run.runId &&
      payload.progress.attemptId === run.attemptId
    )
      return false;
  }
  return true;
}

export function canRetryThreadPotetoRun(run: ThreadPotetoRun): boolean {
  if (
    !["blocked", "interrupted", "cancelled"].includes(run.progress.status) ||
    run.events.length >= MAX_POTETO_CORE_EVENTS ||
    run.attemptCount >= MAX_POTETO_ATTEMPTS
  )
    return false;
  if (run.events.length === 0) return true;

  try {
    const events = decodePotetoEvents(run.events);
    const state = replayPotetoMode(events);
    if (state.status === "candidate-ready" || state.phase === undefined) return false;
    if (state.status === "running") {
      const interrupted = decodePotetoEvents([
        ...events,
        {
          type: "blocked",
          phase: state.phase,
          reason: "Interrupted phase. Explicit retry required.",
        },
      ]);
      return canStartPotetoPhase(interrupted);
    }
    return canStartPotetoPhase(events);
  } catch {
    return false;
  }
}

function canStartPotetoPhase(events: ReadonlyArray<unknown>): boolean {
  try {
    const state = replayPotetoMode(events);
    if (state.phase === undefined || state.status === "candidate-ready") return false;
    replayPotetoMode([...events, { type: "started", phase: state.phase }]);
    return true;
  } catch {
    try {
      const state = replayPotetoMode(events);
      if (
        state.phase !== "review" ||
        state.status !== "blocked" ||
        state.lastReview?.report.repairTarget == null
      )
        return false;
      replayPotetoMode([
        ...events,
        {
          type: "repair-requested",
          phase: "review",
          target: state.lastReview.report.repairTarget,
        },
      ]);
      return true;
    } catch {
      return false;
    }
  }
}

export function hasFinishedPotetoAttempt(
  thread: Pick<OrchestrationThread, "activities">,
  runId: CommandId,
  attemptId: CommandId,
): boolean {
  return thread.activities.some((activity) => {
    if (activity.kind !== "poteto.finished") return false;
    const payload = recordFor(activity);
    return (
      payload?.runId === runId &&
      payload.attemptId === attemptId &&
      payload.progress.runId === runId &&
      payload.progress.attemptId === attemptId
    );
  });
}
