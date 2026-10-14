import {
  CommandId,
  PotetoActivityKind,
  type OrchestrationEvent,
  type PotetoProgress,
  type ThreadId,
} from "@rove-code/contracts";
import { makeDrainableWorker, type DrainableWorker } from "@rove-code/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import {
  decodePotetoEvents,
  potetoRevision,
  replayPotetoMode,
  type PotetoJournal,
} from "./PotetoMode.ts";
import {
  isThreadPotetoActive,
  readThreadPotetoRun,
  type ThreadPotetoRun,
} from "./ThreadPotetoState.ts";
import { ThreadPotetoRunner } from "./ThreadPotetoRunner.ts";

export class ThreadPotetoReactor extends Context.Service<
  ThreadPotetoReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("@rove-code/server/orchestration/poteto/ThreadPotetoReactor") {}
class PotetoAttemptError extends Schema.TaggedError<PotetoAttemptError>()("PotetoAttemptError", {
  message: Schema.String,
  cause: Schema.Unknown,
}) {}
interface Attempt {
  readonly threadId: ThreadId;
  readonly runId: CommandId;
  readonly attemptId: CommandId;
  readonly controller: AbortController;
}

function terminalProgress(run: ThreadPotetoRun, error: unknown): PotetoProgress {
  const reason = (error instanceof Error ? error.message : String(error)).slice(0, 4096);
  if (run.progress.status === "cancelled") return run.progress;
  const state = run.events.length > 0 ? replayPotetoMode(run.events) : undefined;
  return {
    ...run.progress,
    status:
      state?.status === "candidate-ready"
        ? "candidate-ready"
        : (state?.status === "blocked" && run.progress.status === "blocked") || !state
          ? "blocked"
          : "interrupted",
    phase: state?.phase ?? null,
    reason,
    ...(state ? { revision: potetoRevision(state.files) } : {}),
  };
}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const runner = yield* ThreadPotetoRunner;
  const liveness = yield* ThreadBackgroundLivenessService;
  const crypto = yield* Crypto.Crypto;
  const context = yield* Effect.context<OrchestrationEngineService>();
  const runPromise = Effect.runPromiseWith(context);
  const ready = yield* Deferred.make<void>();
  const workers = new Map<ThreadId, DrainableWorker<Attempt>>();
  const active = new Map<ThreadId, Attempt>();
  const kinds = [...PotetoActivityKind.literals];
  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const read = (threadId: ThreadId) =>
    snapshots.getThreadDetailById(threadId, { activityKinds: kinds });
  const finish = Effect.fn("ThreadPotetoReactor.finish")(function* (
    attempt: Pick<Attempt, "threadId" | "runId" | "attemptId">,
    outcome: PotetoProgress | undefined,
    error: unknown,
  ) {
    const thread = yield* read(attempt.threadId);
    if (Option.isNone(thread) || !isThreadPotetoActive(thread.value)) return;
    const run = readThreadPotetoRun(thread.value);
    if (!run || run.runId !== attempt.runId || run.attemptId !== attempt.attemptId) return;
    const progress =
      run.progress.status === "cancelled"
        ? run.progress
        : (outcome ?? terminalProgress(run, error));
    liveness.recordTaskLiveness({
      threadId: attempt.threadId,
      taskId: `poteto:${attempt.attemptId}`,
      taskType: "agent",
      status: "completed",
      kind: "completed",
    });
    yield* engine.dispatch({
      type: "thread.poteto.finish",
      commandId: CommandId.make(yield* crypto.randomUUIDv4),
      threadId: attempt.threadId,
      runId: attempt.runId,
      attemptId: attempt.attemptId,
      progress,
      createdAt: yield* now,
    });
  });
  const finishSafely = (
    attempt: Pick<Attempt, "threadId" | "runId" | "attemptId">,
    outcome: PotetoProgress | undefined,
    error: unknown,
  ) =>
    finish(attempt, outcome, error).pipe(
      // Cancellation can win between the read and finish receipt. Re-read it once,
      // rather than overwriting the user's cancellation with a passing candidate.
      Effect.catch(() => finish(attempt, outcome, error)),
    );
  const processAttempt = (attempt: Attempt) => {
    let operation: Promise<PotetoProgress> | undefined;
    return Effect.gen(function* () {
      const thread = yield* read(attempt.threadId);
      if (Option.isNone(thread) || !isThreadPotetoActive(thread.value)) return;
      const run = readThreadPotetoRun(thread.value);
      if (!run || run.runId !== attempt.runId || run.attemptId !== attempt.attemptId) return;
      if (run.progress.status === "cancelled")
        return yield* finishSafely(attempt, undefined, "Cancelled by user");
      const projects =
        thread.value.projectId === null
          ? []
          : yield* snapshots.getProjectShells([thread.value.projectId]);
      const workspace = resolveThreadWorkspaceCwd({ thread: thread.value, projects });
      if (!workspace)
        return yield* finishSafely(
          attempt,
          undefined,
          "Poteto requires a thread workspace with a committed Git baseline.",
        );
      const events = [...decodePotetoEvents(run.events)];
      const journal: PotetoJournal = {
        read: () => structuredClone(events),
        append: async (expectedLength, event) => {
          attempt.controller.signal.throwIfAborted();
          if (events.length !== expectedLength) throw new Error("Stale Poteto journal owner.");
          await runPromise(
            Effect.gen(function* () {
              yield* engine.dispatch({
                type: "thread.poteto.append",
                commandId: CommandId.make(yield* crypto.randomUUIDv4),
                threadId: attempt.threadId,
                runId: run.runId,
                attemptId: run.attemptId,
                expectedLength,
                event,
                createdAt: yield* now,
              });
            }),
          );
          events.push(structuredClone(event));
        },
      };
      const result = yield* Effect.tryPromise({
        try: () =>
          (operation = runner.run({
            threadId: attempt.threadId,
            run,
            workspace,
            journal,
            signal: attempt.controller.signal,
          })),
        catch: (error) =>
          new PotetoAttemptError({
            message: error instanceof Error ? error.message : String(error),
            cause: error,
          }),
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.promise(async () => {
            // Effect interruption alone doesn't drain a JavaScript SDK/Docker promise.
            attempt.controller.abort(new Error("Host stopped. Explicit retry required."));
            await operation?.catch(() => {});
          }),
        ),
      );
      yield* finishSafely(attempt, result, "Poteto attempt ended without a terminal result.");
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => finishSafely(attempt, undefined, Cause.squash(cause)),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "Poteto attempt could not finalize; restart recovery will mark it interrupted",
          { threadId: attempt.threadId, cause: Cause.pretty(cause) },
        ),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (active.get(attempt.threadId) === attempt) active.delete(attempt.threadId);
          liveness.recordTaskLiveness({
            threadId: attempt.threadId,
            taskId: `poteto:${attempt.attemptId}`,
            taskType: "agent",
            status: "completed",
            kind: "completed",
          });
        }),
      ),
    );
  };
  const schedule = Effect.fn("ThreadPotetoReactor.schedule")(function* (
    threadId: ThreadId,
    runId: CommandId,
    attemptId: CommandId,
  ) {
    const existing = active.get(threadId);
    if (existing?.attemptId === attemptId) return;
    const attempt = { threadId, runId, attemptId, controller: new AbortController() };
    active.set(threadId, attempt);
    liveness.recordTaskLiveness({
      threadId,
      taskId: `poteto:${attemptId}`,
      taskType: "agent",
      status: "running",
      kind: "started",
    });
    let worker = workers.get(threadId);
    if (!worker) {
      worker = yield* makeDrainableWorker(processAttempt);
      workers.set(threadId, worker);
    }
    yield* worker.enqueue(attempt);
  });
  const receive = Effect.fn("ThreadPotetoReactor.receive")(function* (event: OrchestrationEvent) {
    if (
      event.type !== "thread.activity-appended" ||
      !event.payload.activity.kind.startsWith("poteto.")
    )
      return;
    const threadId = event.payload.threadId;
    const thread = yield* read(threadId);
    if (Option.isNone(thread)) return;
    const run = readThreadPotetoRun(thread.value);
    if (!run || !isThreadPotetoActive(thread.value)) return;
    if (run.progress.status === "cancelled") {
      active.get(threadId)?.controller.abort(new Error("Cancelled by user"));
      if (!active.has(threadId)) yield* schedule(threadId, run.runId, run.attemptId);
    } else if (
      event.payload.activity.kind === "poteto.requested" ||
      (event.payload.activity.kind === "poteto.control" && run.progress.status === "requested")
    ) {
      yield* schedule(threadId, run.runId, run.attemptId);
    }
  });
  const recover = Effect.fn("ThreadPotetoReactor.recover")(function* (startupSequence: number) {
    const snapshot = yield* snapshots.getCommandReadModel();
    for (const thread of snapshot.threads) {
      if (!isThreadPotetoActive(thread)) continue;
      const run = readThreadPotetoRun(thread);
      if (!run) continue;
      const owner = thread.activities.findLast(
        (activity) => activity.kind === "poteto.requested" || activity.kind === "poteto.control",
      );
      if ((owner?.sequence ?? 0) > startupSequence) continue;
      let progress =
        run.progress.status === "cancelled"
          ? run.progress
          : terminalProgress(
              run,
              "Host restarted. No workers were restarted; explicitly retry this attempt.",
            );
      if (progress.status === "candidate-ready") {
        progress = yield* Effect.tryPromise({
          try: () => runner.recoverCandidate({ threadId: thread.id, run }),
          catch: (error) =>
            new PotetoAttemptError({
              message: error instanceof Error ? error.message : String(error),
              cause: error,
            }),
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              ...progress,
              reason: `Candidate verified, but patch recovery failed: ${error.message}`.slice(
                0,
                4096,
              ),
            }),
          ),
        );
      }
      // Unstarted requests also become interrupted, not silently resumed/billed.
      yield* finishSafely(
        { threadId: thread.id, runId: run.runId, attemptId: run.attemptId },
        progress.status === "blocked" && run.events.length === 0
          ? { ...progress, status: "interrupted" }
          : progress,
        "Host restarted",
      );
    }
  });
  const start = Effect.fn("ThreadPotetoReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    const startupSequence = yield* engine.latestSequence;
    yield* forkParked(
      Effect.gen(function* () {
        yield* recover(startupSequence).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Poteto recovery failed", { cause: Cause.pretty(cause) }),
          ),
          Effect.ensuring(Deferred.succeed(ready, undefined)),
        );
        yield* Stream.runForEach(events, (event) =>
          receive(event).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Poteto intent failed", { cause: Cause.pretty(cause) }),
            ),
          ),
        );
      }),
    );
  });
  return {
    start,
    drain: Deferred.await(ready).pipe(
      Effect.andThen(
        Effect.forEach(workers.values(), (worker) => worker.drain, {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    ),
  } satisfies ThreadPotetoReactor["Service"];
});
export const layer = Layer.effect(ThreadPotetoReactor, make);
