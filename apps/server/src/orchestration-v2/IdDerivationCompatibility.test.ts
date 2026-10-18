import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@rove-code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@rove-code/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@rove-code/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Identity tests must not launch providers"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  database,
  IdAllocator.layer,
  EventStore.layer.pipe(Layer.provide(database)),
  CheckpointService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        NodeCrypto.layer,
        Layer.mock(CheckpointStore.CheckpointStore)({
          isGitRepository: () => Effect.succeed(false),
        }),
      ),
    ),
  ),
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "id-derivation-compatibility" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

const createIdentityThread = Effect.fnUntraced(function* (
  threadId: ThreadId,
  version: 2 | undefined,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const creation = {
    type: "thread.create" as const,
    commandId: CommandId.make(`create:${threadId}`),
    threadId,
    projectId: ProjectId.make("project:namespace"),
    title: "Identity namespace",
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    createdBy: "user" as const,
    creationSource: "web" as const,
  };
  if (version === 2) {
    yield* orchestrator.dispatch(creation);
  } else {
    // The persisted event really lacks the field, as on a pre-upgrade server.
    const thread: OrchestrationV2AppThread = {
      ...creation,
      id: threadId,
      providerInstanceId: instanceId,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make(`created:${threadId}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: thread,
        },
      ],
    });
  }
});

it.effect.each([undefined, 2] as const)(
  "keeps namespace %s across persisted reload, continuation, output, interrupts and checkpoints",
  (version) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const events = yield* EventStore.EventStoreV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const threadId = ThreadId.make(`thread:namespace:${version ?? "legacy"}`);
      const now = yield* DateTime.now;
      yield* createIdentityThread(threadId, version);
      const created = (yield* Stream.runCollect(
        events.read({ threadId, eventType: "thread.created" }),
      ))[0]!.event;
      assert.equal(created.type, "thread.created");
      if (created.type === "thread.created")
        assert.equal(created.payload.idDerivationVersion, version);
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`rename:${threadId}`),
        threadId,
        title: "Resumed identity namespace",
      });
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make(`resume:${threadId}`),
        threadId,
      });
      const namespace = {
        idDerivationVersion: (yield* projections.getThread(threadId)).idDerivationVersion,
      };
      assert.equal(namespace.idDerivationVersion, version);
      const start = (ordinal: number) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`send:${threadId}:${ordinal}`),
          threadId,
          messageId: MessageId.make(`message:${threadId}:${ordinal}`),
          text: "Continue",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
      yield* start(1);
      let projection = yield* projections.getThreadProjection(threadId);
      const first = projection.runs[0]!;
      assert.equal(first.id, ids.derive.run({ ...namespace, threadId, ordinal: 1 }));
      assert.equal(first.rootNodeId, ids.derive.rootNode({ ...namespace, runId: first.id }));
      assert.equal(
        first.activeAttemptId,
        ids.derive.runAttempt({ ...namespace, runId: first.id, attemptOrdinal: 1 }),
      );
      assert.equal(
        projection.turnItems[0]!.id,
        ids.derive.userTurnItem({ ...namespace, messageId: first.userMessageId }),
      );
      assert.equal(first.id.includes(":v2:"), version === 2);
      // Persist completion, then continue a completed namespace after a fresh read.
      yield* sink.write({
        events: [
          {
            id: EventId.make(`complete:${threadId}`),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: { ...first, status: "completed", completedAt: now },
          },
        ],
      });
      yield* start(2);
      yield* start(2); // accepted command receipt must not duplicate the run or user item
      projection = yield* projections.getThreadProjection(threadId);
      assert.lengthOf(projection.runs, 2);
      assert.lengthOf(
        projection.turnItems.filter((item) => item.type === "user_message"),
        2,
      );
      const run = projection.runs[1]!;
      assert.equal(run.id, ids.derive.run({ ...namespace, threadId, ordinal: 2 }));
      const rootNode = projection.nodes.find((node) => node.id === run.rootNodeId)!;
      const providerThread = projection.providerThreads.find(
        (thread) => thread.id === run.providerThreadId,
      )!;

      // Native-provider ids deliberately retain their historical encoding, including
      // deltas which re-derive an existing command row instead of carrying its id.
      const nativeItemId = `${threadId}:native:command%3Aone`;
      const itemId = () =>
        ids.derive.turnItemFromProviderItem({ driver: adapter.driver, nativeItemId });
      const commandItem = {
        id: itemId(),
        threadId,
        runId: run.id,
        nodeId: rootNode.id,
        providerThreadId: providerThread.id,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 250,
        status: "running" as const,
        title: "Command",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "command_execution" as const,
        input: "printf hello",
      };
      const ingest = (
        item:
          | typeof commandItem
          | (Omit<typeof commandItem, "status" | "completedAt"> & {
              status: "completed";
              completedAt: DateTime.Utc;
              output: string;
            }),
      ) =>
        sink.write({
          events: [
            {
              id: EventId.make(`command-item:${threadId}:${item.status}`),
              type: "turn-item.updated",
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: item,
            },
          ],
        });
      yield* ingest(commandItem);
      const hub = yield* CommandOutputHub.make;
      yield* hub.append({ threadId, itemId: itemId(), chunk: "hello" });
      const frame = yield* Stream.runHead(hub.subscribe({ threadId, itemId: itemId() }));
      assert.isTrue(Option.isSome(frame));
      if (Option.isSome(frame)) assert.equal(frame.value.text, "hello");
      yield* ingest({
        ...commandItem,
        id: itemId(),
        status: "completed",
        completedAt: now,
        output: "hello",
      });
      assert.lengthOf(
        (yield* projections.getThreadProjection(threadId)).turnItems.filter(
          (item) => item.id === itemId(),
        ),
        1,
      );

      const requestId = ids.derive.runSignalTurnItem({
        runId: run.id,
        signal: "interrupt-request",
      });
      const result = RunExecutionService.makeInterruptResultTurnItem({
        idAllocator: ids,
        run,
        rootNode,
        providerThread,
        completedAt: now,
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make(`interrupt-request:${threadId}`),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: {
              ...commandItem,
              id: requestId,
              ordinal: 251,
              parentItemId: null,
              type: "run_interrupt_request",
              message: "Stop",
            },
          },
        ],
      });
      assert.isTrue(
        yield* projections.hasUnpairedRunInterruptRequest(threadId, requestId, result.id),
      );
      assert.equal(result.parentItemId, requestId);
      yield* sink.write({
        events: [
          {
            id: EventId.make(`interrupt-result:${threadId}`),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: result,
          },
        ],
      });
      assert.isFalse(
        yield* projections.hasUnpairedRunInterruptRequest(threadId, requestId, result.id),
      );

      const scope = projection.checkpointScopes.find(
        (scope) => scope.id === rootNode.checkpointScopeId,
      )!;
      assert.ok(scope);
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 0,
      });
      const checkpoint = yield* checkpoints.capture({
        scope,
        ordinalWithinScope: 1,
        runId: run.id,
        nodeId: rootNode.id,
        appRunOrdinal: run.ordinal,
        capturedAt: now,
      });
      assert.equal(checkpoint.parentCheckpointId, baseline.id);
      assert.equal(
        baseline.id,
        yield* ids.allocate.checkpoint({ checkpointScopeId: scope.id, name: "0" }),
      );
      const again = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 1,
      });
      assert.equal(checkpoint.id, again.id);
      assert.equal(checkpoint.ref, again.ref);
      assert.equal((yield* projections.getThread(threadId)).idDerivationVersion, version);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([undefined, 2] as const)(
  "uses parent namespace %s for delegation but creates a fresh v2 child",
  (version) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const threadId = ThreadId.make(`thread:delegation-namespace:${version ?? "legacy"}`);
      yield* createIdentityThread(threadId, version);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("start:delegation-namespace"),
        threadId,
        messageId: MessageId.make("message:delegation-namespace"),
        text: "Delegate",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      let parent = yield* projections.getThreadProjection(threadId);
      for (let depth = 1; depth <= 6; depth++) {
        const run = parent.runs[0]!;
        const commandId = CommandId.make(
          `command:mcp:${encodeURIComponent(parent.thread.id)}:${encodeURIComponent(run.id)}:delegate-task:${depth}`,
        );
        const command = {
          type: "delegated_task.request" as const,
          commandId,
          parentThreadId: parent.thread.id,
          parentRunId: run.id,
          parentNodeId: run.rootNodeId!,
          task: "Inspect the next layer",
          modelSelection,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          createdBy: "agent" as const,
          creationSource: "mcp" as const,
        };
        yield* orchestrator.dispatch(command);
        yield* orchestrator.dispatch(command);
        const updated = yield* projections.getThreadProjection(parent.thread.id);
        assert.lengthOf(updated.subagents, 1);
        const namespace = { idDerivationVersion: parent.thread.idDerivationVersion, commandId };
        const task = updated.subagents[0]!;
        assert.equal(task.id, ids.derive.delegatedTaskNode(namespace));
        assert.equal(task.childThreadId, ids.derive.delegatedTaskThread(namespace));
        assert.equal(task.id.includes(":v2:"), parent.thread.idDerivationVersion === 2);
        if (parent.thread.idDerivationVersion === 2) assert.isAtMost(task.id.length, 72);
        parent = yield* projections.getThreadProjection(task.childThreadId!);
        assert.equal(parent.thread.idDerivationVersion, 2);
        assert.equal(parent.messages[0]!.id, ids.derive.delegatedTaskMessage(namespace));
        assert.isAtMost(parent.runs[0]!.id.length, 72);
      }
    }).pipe(Effect.provide(layerTest)),
);
