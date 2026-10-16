import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
} from "@rove-code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const database = Sqlite.layerMemory;
const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(Layer.provide(database));
const sink = EventSink.layer.pipe(Layer.provide(Layer.merge(stores, database)));
const layerTest = Layer.mergeAll(database, stores, sink);
const now = DateTime.makeUnsafe("2026-10-01T00:00:00Z");
const threadId = ThreadId.make("thread:ingest-hot-path");
const nodeId = NodeId.make("node:ingest-hot-path");
const runId = RunId.make("run:ingest-hot-path");
const instanceId = ProviderInstanceId.make("codex");
const node: OrchestrationV2ExecutionNode = {
  id: nodeId,
  threadId,
  runId,
  parentNodeId: null,
  rootNodeId: nodeId,
  kind: "assistant_message",
  status: "running",
  countsForRun: false,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  runtimeRequestId: null,
  checkpointScopeId: null,
  startedAt: now,
  completedAt: null,
};
const nodeEvent = (payload = node, suffix = "initial"): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:node:${suffix}`),
  type: "node.updated",
  threadId: payload.threadId,
  occurredAt: now,
  payload,
});
const threadEvent: OrchestrationV2DomainEvent = {
  id: EventId.make("event:thread:initial"),
  type: "thread.created",
  threadId,
  occurredAt: now,
  payload: {
    id: threadId,
    projectId: ProjectId.make("project:ingest-hot-path"),
    title: "Ingest test",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
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
  },
};
const seed = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  yield* eventSink.write({ events: [threadEvent, nodeEvent()] });
  return yield* ProjectionStore.ProjectionStoreV2;
});
const traceNodeReads = () => {
  const reads: string[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (time, exit) => {
        end(time, exit);
        const query = span.attributes.get("db.query.text");
        if (
          typeof query === "string" &&
          /SELECT payload_json FROM orchestration_v2_projection_nodes/.test(query)
        )
          reads.push(query);
      };
      return span;
    },
  });
  return { reads, tracer };
};
describe("ingest hot path correctness", () => {
  it.effect(
    "reuses the event store's full JSON in projections without adding it to published events",
    () =>
      Effect.gen(function* () {
        const projections = yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const forwarded: Array<string | undefined> = [];
        const eventSink = yield* EventSink.EventSinkV2.pipe(
          Effect.provide(
            Layer.fresh(EventSink.layer).pipe(
              Layer.provide(
                Layer.succeed(ProjectionStore.ProjectionStoreV2, {
                  ...projections,
                  apply: (event, payloadJson) => {
                    forwarded.push(payloadJson);
                    return projections.apply(event, payloadJson);
                  },
                }),
              ),
            ),
          ),
        );
        const createdAt = DateTime.makeUnsafe("2026-10-01T00:00:01.123Z");
        const updatedAt = DateTime.makeUnsafe("2026-10-01T00:00:02.456Z");
        const text = "é🙂\n".repeat(16_000);
        const events: OrchestrationV2DomainEvent[] = [
          {
            id: EventId.make("event:message"),
            type: "message.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: MessageId.make("message:hot-path"),
              threadId,
              runId,
              nodeId,
              createdBy: "agent",
              creationSource: "provider",
              role: "assistant",
              text,
              attachments: [],
              createdAt,
              updatedAt,
              streaming: true,
            },
          },
          {
            id: EventId.make("event:item"),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("item:hot-path"),
              threadId,
              runId: null,
              nodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "running",
              title: null,
              startedAt: createdAt,
              completedAt: null,
              updatedAt,
              type: "assistant_message",
              messageId: MessageId.make("message:hot-path"),
              text,
              streaming: true,
            },
          },
        ];
        const stored = yield* eventSink.write({ events });
        const rows = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_events WHERE event_id IN ('event:message', 'event:item') ORDER BY sequence`;
        assert.deepEqual(
          forwarded,
          rows.map((row) => row.payload_json),
        );
        const messages = yield* sql<{
          payload_json: string;
          created_at: string;
          updated_at: string;
        }>`SELECT payload_json, created_at, updated_at FROM orchestration_v2_projection_messages`;
        const items = yield* sql<{
          payload_json: string;
          updated_at: string;
        }>`SELECT payload_json, updated_at FROM orchestration_v2_projection_turn_items`;
        assert.equal(messages[0]?.payload_json, forwarded[0]);
        assert.equal(items[0]?.payload_json, forwarded[1]);
        assert.equal(messages[0]?.created_at, DateTime.formatIso(createdAt));
        assert.equal(messages[0]?.updated_at, DateTime.formatIso(updatedAt));
        assert.equal(items[0]?.updated_at, DateTime.formatIso(updatedAt));
        assert.isFalse(
          stored.some((entry) => "payloadJson" in entry || "payloadJson" in entry.event),
        );
      }).pipe(Effect.provide(Layer.fresh(layerTest))),
  );

  it.effect("avoids SQL for warmed identical nodes and invalidates server-written changes", () =>
    Effect.gen(function* () {
      const projections = yield* seed;
      const eventSink = yield* EventSink.EventSinkV2;
      const { reads, tracer } = traceNodeReads();
      const matches = (sent = node) =>
        projections.isNodeStored(sent).pipe(Effect.withTracer(tracer));
      assert.isTrue(yield* matches());
      assert.lengthOf(reads, 1);
      assert.isTrue(yield* matches({ ...node }));
      assert.lengthOf(reads, 1);
      const completed = { ...node, status: "completed" as const, completedAt: now };
      yield* eventSink.write({ events: [nodeEvent(completed, "completed")] });
      assert.isFalse(yield* matches());
      assert.isTrue(yield* matches(completed));
      assert.lengthOf(reads, 3);
      // A fork's inherited node is not a canonical node of the child thread.
      assert.isFalse(yield* matches({ ...node, threadId: ThreadId.make("thread:fork") }));
    }).pipe(Effect.provide(Layer.fresh(layerTest))),
  );

  it.effect("does not remember node writes from a failed event/projection transaction", () =>
    Effect.gen(function* () {
      const projections = yield* seed;
      const eventSink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const changed = { ...node, countsForRun: true };
      assert.isTrue(yield* projections.isNodeStored(node));
      // Metadata is written after applying the node but in the same transaction.
      yield* sql`CREATE TRIGGER fail_projection_metadata BEFORE INSERT ON orchestration_v2_projection_metadata BEGIN SELECT RAISE(ABORT, 'test write failure'); END`;
      const result = yield* Effect.exit(
        eventSink.write({ events: [nodeEvent(changed, "changed")] }),
      );
      assert.isTrue(Exit.isFailure(result));
      assert.isFalse(yield* projections.isNodeStored(changed));
      assert.isTrue(yield* projections.isNodeStored(node));
    }).pipe(Effect.provide(Layer.fresh(layerTest))),
  );

  it.effect("bypasses hints for nested savepoint reads and failed COMMITs", () =>
    Effect.gen(function* () {
      const projections = yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const changed = { ...node, countsForRun: true };
      assert.isTrue(yield* projections.isNodeStored(node));
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const nested = yield* Effect.exit(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* projections.apply(nodeEvent(changed, "savepoint"));
                assert.isTrue(yield* projections.isNodeStored(changed));
                return yield* Effect.fail("rollback savepoint");
              }),
            ),
          );
          assert.isTrue(Exit.isFailure(nested));
          assert.isFalse(yield* projections.isNodeStored(changed));
          assert.isTrue(yield* projections.isNodeStored(node));
        }),
      );
      yield* sql`CREATE TABLE cache_parent (id INTEGER PRIMARY KEY)`;
      yield* sql`CREATE TABLE cache_child (parent_id INTEGER REFERENCES cache_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
      const failed = yield* Effect.exit(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* projections.apply(nodeEvent(changed, "commit-failure"));
            assert.isTrue(yield* projections.isNodeStored(changed));
            yield* sql`INSERT INTO cache_child (parent_id) VALUES (1)`;
          }),
        ),
      );
      assert.isTrue(Exit.isFailure(failed));
      // This driver currently leaves deferred-constraint COMMIT failures open.
      // Cold reads must fail rather than remember dirty rows; recover the test
      // connection explicitly, then verify that no uncommitted hint survived.
      assert.isTrue(Exit.isFailure(yield* Effect.exit(projections.isNodeStored(changed))));
      yield* sql`ROLLBACK`;
      assert.isFalse(yield* projections.isNodeStored(changed));
      assert.isTrue(yield* projections.isNodeStored(node));
    }).pipe(Effect.provide(Layer.fresh(layerTest))),
  );

  it.effect("does not serve a stale hint while a node write awaits commit", () =>
    Effect.gen(function* () {
      const projections = yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const changed = { ...node, countsForRun: true };
      assert.isTrue(yield* projections.isNodeStored(node));
      const writer = yield* Effect.forkChild(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* projections.apply(nodeEvent(changed, "in-flight"));
            yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(release);
          }),
        ),
      );
      yield* Deferred.await(held);
      const reader = yield* Effect.forkChild(projections.isNodeStored(node));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(writer);
      assert.isFalse(yield* Fiber.join(reader));
      assert.isTrue(yield* projections.isNodeStored(changed));
    }).pipe(Effect.provide(Layer.fresh(layerTest))),
  );

  it.effect("evicts ended runs, and a restarted store verifies SQL before warming hints", () =>
    Effect.gen(function* () {
      const projections = yield* seed;
      const eventSink = yield* EventSink.EventSinkV2;
      const { reads, tracer } = traceNodeReads();
      const matches = projections.isNodeStored(node).pipe(Effect.withTracer(tracer));
      assert.isTrue(yield* matches);
      assert.isTrue(yield* matches);
      assert.lengthOf(reads, 1);
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:run:terminal"),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId,
              ordinal: 1,
              providerInstanceId: instanceId,
              modelSelection: { instanceId, model: "gpt-5.4" },
              providerThreadId: null,
              userMessageId: MessageId.make("message:run"),
              rootNodeId: nodeId,
              activeAttemptId: null,
              status: "rolled_back",
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
      });
      assert.isTrue(yield* matches);
      assert.lengthOf(reads, 2);
      const restarted = yield* ProjectionStore.ProjectionStoreV2.pipe(
        Effect.provide(Layer.fresh(ProjectionStore.layer)),
      );
      assert.isTrue(yield* restarted.isNodeStored(node).pipe(Effect.withTracer(tracer)));
      assert.lengthOf(reads, 3);
    }).pipe(Effect.provide(Layer.fresh(layerTest))),
  );

  it.effect("clears hints when rebuilding removes canonical rows absent from the event log", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* eventSink.write({ events: [threadEvent] });
      // An unexpected canonical row cannot survive rebuilding from the retained log.
      yield* projections.apply(nodeEvent());
      assert.isTrue(yield* projections.isNodeStored(node));
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2.pipe(
        Effect.provide(ProjectionMaintenance.layer),
      );
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.isFalse(yield* projections.isNodeStored(node));
    }).pipe(Effect.provide(Layer.fresh(layerTest))),
  );

  it.effect("bounds cached payloads and falls back to SQL after eviction", () =>
    Effect.gen(function* () {
      const projections = yield* seed;
      const { reads, tracer } = traceNodeReads();
      const matches = (sent: OrchestrationV2ExecutionNode) =>
        projections.isNodeStored(sent).pipe(Effect.withTracer(tracer));
      for (let index = 0; index < 4_100; index++) {
        const sent = { ...node, id: NodeId.make(`node:bounded:${index}`) };
        yield* projections.apply(nodeEvent(sent, `bounded:${index}`));
        assert.isTrue(yield* matches(sent));
      }
      reads.length = 0;
      assert.isTrue(yield* matches({ ...node, id: NodeId.make("node:bounded:4099") }));
      assert.isEmpty(reads);
      assert.isTrue(yield* matches({ ...node, id: NodeId.make("node:bounded:0") }));
      assert.lengthOf(reads, 1);
      const large = { ...node, id: NodeId.make("x".repeat(20_000)) };
      yield* projections.apply(nodeEvent(large, "oversized"));
      assert.isTrue(yield* matches(large));
      assert.isTrue(yield* matches(large));
      assert.lengthOf(reads, 3);
    }).pipe(Effect.provide(Layer.fresh(layerTest))),
  );
});
