import { CommandId, MessageId, type OrchestrationV2Command } from "@rove-code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { MAX_LIMIT_RECOVERY_ATTEMPTS } from "./usageLimitRecovery.ts";

/** The persisted run and reset form the identity of one recovery opportunity. */
export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const exhausted = thread.limitRecoveryAttempts >= MAX_LIMIT_RECOVERY_ATTEMPTS;
  // The cap limits what the worker arms itself; a user's explicit choice is consent.
  autoResume = autoResume && !exhausted;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        ...(autoResume ? { automatic: true } : {}),
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    (exhausted && recovery.automatic === true) ||
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const nextDueAt = yield* Ref.make<number | null>(null);
  const sweep = Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
      includeFuture: true,
    });
    const nowMs = DateTime.toEpochMillis(now);
    let next: number | null = null;
    for (const thread of candidates) {
      const resetMs = Date.parse(thread.usageLimitResetAt ?? "");
      const due = Math.max(
        resetMs,
        thread.snoozedUntil == null ? 0 : DateTime.toEpochMillis(thread.snoozedUntil),
      );
      if (Number.isFinite(due) && due > nowMs) next = Math.min(next ?? Infinity, due);
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
      );
      if (command === null) continue;
      yield* threads.dispatch(command).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
    yield* Ref.set(nextDueAt, next);
  });
  return { sweep, nextDueAt: Ref.get(nextDueAt) };
});

// The shared scheduler derives due work from persisted failures and recovery
// choices, so restarts need no timer restoration or connected client.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { sweep, nextDueAt } = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    const engine = yield* Orchestrator.OrchestratorV2;
    const settings = yield* ServerSettings.ServerSettingsService;
    const { wake } = yield* scheduler.register("usage-limit-recovery", sweep(), nextDueAt);
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        switch (event.type) {
          case "run.updated":
            return event.payload.status === "failed" ? wake : Effect.void;
          // Root failure details may land after the run status, and recovery choices
          // or snooze changes may move the deadline while its old timer is asleep.
          case "turn-item.updated":
            return event.payload.type === "error" ? wake : Effect.void;
          case "thread.metadata-updated":
          case "thread.snoozed":
          case "thread.unsnoozed":
          case "thread.unarchived":
          case "thread.unsettled":
          case "runtime-request.updated":
            return wake;
          default:
            return Effect.void;
        }
      }),
    );
    yield* forkParked(Stream.runForEach(settings.streamChanges, () => wake));
  }),
);
