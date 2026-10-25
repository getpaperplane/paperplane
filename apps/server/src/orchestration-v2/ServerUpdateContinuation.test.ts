import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@getpaperplane/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as IdAllocator from "@getpaperplane/provider-core/server/IdAllocator";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Recovery from "./ProviderRuntimeRecoveryService.ts";
import * as Threads from "./ThreadManagementService.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";

const threadId = ThreadId.make("thread:update");
const runId = RunId.make("run:update");
const instanceId = ProviderInstanceId.make("codex");
const effectId = `effect:restart-continuation:${runId}`;

const liveProjection = () =>
  ({
    thread: {
      id: threadId,
      projectId: ProjectId.make("project:update"),
      providerInstanceId: instanceId,
      archivedAt: null,
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        ordinal: 1,
        status: "running",
        providerInstanceId: instanceId,
        providerThreadId: "native",
        activeAttemptId: "attempt",
        userMessageId: "message:user",
        modelSelection: { instanceId, model: "test" },
      },
    ],
    providerThreads: [
      {
        id: "native",
        appThreadId: threadId,
        ownerNodeId: null,
        driver: "codex",
        providerInstanceId: instanceId,
        providerSessionId: "session",
        status: "active",
        nativeThreadRef: { driver: "codex", nativeId: "native", strength: "strong" },
      },
    ],
    providerSessions: [
      { id: "session", driver: "codex", providerInstanceId: instanceId, status: "running" },
    ],
    providerTurns: [
      { id: "turn", providerThreadId: "native", runAttemptId: "attempt", status: "running" },
    ],
    runtimeRequests: [],
    turnItems: [],
    attempts: [],
    subagents: [],
    nodes: [],
    messages: [],
  }) as unknown as OrchestrationV2ThreadProjection;

const layerDatabase = Sqlite.layerMemory;
const layerOutbox = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
const layerSink = EventSink.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerDatabase,
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      layerOutbox,
    ),
  ),
);
const layerTest = Layer.mergeAll(
  layerOutbox,
  layerSink,
  IdAllocator.layer,
  ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false }),
);

it.effect(
  "holds one-shot update intent until restart, delivers once with the preference off, and leaves later runs alone",
  () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      let projection = liveProjection();
      const recovery = yield* Recovery.make.pipe(
        Effect.provide(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.sync(() => projection),
          }),
        ),
      );
      const settings = yield* ServerSettings.ServerSettingsService;
      const prompts: string[] = [];
      const threads = Layer.mock(Threads.ThreadManagementService)({
        getThreadRecords: () => Effect.sync(() => projection),
        recoverDelegatedTask: () => Effect.void,
        dispatch: (command) =>
          Effect.sync(() => {
            if (command.type !== "message.dispatch") throw new Error("unexpected command");
            prompts.push(command.text);
            projection = { ...projection, messages: [{ id: command.messageId } as never] };
            return {} as never;
          }),
      });
      const executor = Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
        execute: (effect) => {
          if (effect.request.type !== "provider-runtime.continue") return Effect.void;
          return continueRestartedRun({
            threadId: effect.threadId,
            sourceRunId: effect.request.sourceRunId,
            requestedByUpdate: effect.request.requestedByUpdate,
          }).pipe(
            Effect.provide(threads),
            Effect.provideService(ServerSettings.ServerSettingsService, settings),
            Effect.orDie,
          );
        },
      });
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        assert.deepEqual(yield* recovery.prepareForServerUpdate, [threadId]);
        yield* recovery.prepareForServerUpdate;
        assert.equal(yield* worker.drain(), 0);
        assert.isTrue(Option.isNone(yield* outbox.nextClaimableAt));
        // A held intent must not block later lifecycle work on the same thread.
        yield* outbox.enqueue([
          {
            id: "effect:cleanup",
            commandId: CommandId.make("command:cleanup"),
            threadId,
            request: { type: "terminal.cleanup" },
          },
        ]);
        assert.equal(yield* worker.drain(), 1);
        assert.deepEqual(prompts, []);
        // Simulate the process boundary after providers stop. Reconciliation
        // terminalizes the source; the marker retains the update's consent.
        projection = {
          ...projection,
          runs: [{ ...projection.runs[0]!, status: "cancelled" }],
          providerTurns: [{ ...projection.providerTurns[0]!, status: "cancelled" }],
        };
        yield* outbox.reconcileAfterProcessLoss;
        assert.equal(yield* worker.drain(), 1);
        assert.deepEqual(prompts, ["Continue where you left off."]);
        yield* outbox.reconcileAfterProcessLoss;
        assert.equal(yield* worker.drain(), 0);
        projection = {
          ...liveProjection(),
          runs: [{ ...liveProjection().runs[0]!, id: RunId.make("run:later") }],
        };
        yield* recovery.prepareForShutdown;
        assert.equal(yield* worker.drain(), 0);
        assert.deepEqual(prompts, ["Continue where you left off."]);
      }).pipe(Effect.provide(EffectWorker.layer.pipe(Layer.provide(executor))));
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "discards a failed update's intent, allowing a retry without waking an unrelated restart",
  () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const recovery = yield* Recovery.make.pipe(
        Effect.provide(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(liveProjection()),
          }),
        ),
      );
      const prepared = yield* recovery.prepareForServerUpdate;
      yield* recovery.cancelServerUpdate(prepared);
      assert.isTrue(Option.isNone(yield* outbox.get(effectId)));
      yield* outbox.reconcileAfterProcessLoss;
      assert.isTrue(
        Option.isNone(yield* outbox.claimNext({ workerId: "test", leaseDurationMs: 1000 })),
      );
      yield* recovery.prepareForServerUpdate;
      assert.isTrue(Option.isSome(yield* outbox.get(effectId)));
    }).pipe(Effect.provide(layerTest)),
);

it.effect("does not record partial consent when one projection fails", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const missing = ThreadId.make("thread:missing");
    const recovery = yield* Recovery.make.pipe(
      Effect.provide(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId, missing]),
          getRuntimeRecoveryProjection: (id) =>
            id === missing
              ? Effect.fail(
                  new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId: id }),
                )
              : Effect.succeed(liveProjection()),
        }),
      ),
    );
    yield* recovery.prepareForServerUpdate.pipe(Effect.flip);
    assert.isTrue(Option.isNone(yield* outbox.get(effectId)));
  }).pipe(Effect.provide(layerTest)),
);
