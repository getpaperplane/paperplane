import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@getpaperplane/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const threadId = ThreadId.make("thread:read-contention");
const instanceId = ProviderInstanceId.make("codex");
const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const created: Extract<OrchestrationV2DomainEvent, { type: "thread.created" }> = {
  id: EventId.make("event:contention:create"),
  type: "thread.created",
  threadId,
  occurredAt: now,
  payload: {
    id: threadId,
    projectId: ProjectId.make("project:contention"),
    title: "Committed",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  },
};
const changed: OrchestrationV2DomainEvent = {
  ...created,
  id: EventId.make("event:contention:update"),
  type: "thread.metadata-updated",
  payload: { ...created.payload, title: "Uncommitted" },
};

const withFileStore = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | ProjectionStore.ProjectionStoreV2
    | OrchestrationEventStore.OrchestrationEventStore
    | SqlClient.SqlClient
    | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({
      prefix: "paperplane-read-contention-test-",
    });
    const persistence = SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite"));
    return yield* effect.pipe(
      Effect.provide(
        Layer.mergeAll(ProjectionStore.layer, OrchestrationEventStore.layer).pipe(
          Layer.provideMerge(persistence),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const stored = yield* events.appendAgentEvents({ events: [created] });
      yield* projections.apply(created);
      return stored[0]!.sequence;
    }),
  );
});

it.effect(
  "hot reads progress during a held writer transaction and see its commit on their next read",
  () =>
    withFileStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const events = yield* OrchestrationEventStore.OrchestrationEventStore;
        const sequence = yield* seed;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const writer = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const stored = yield* events.appendAgentEvents({ events: [changed] });
              yield* projections.apply(changed);
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return stored[0]!.sequence;
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        // Awaiting these before releasing the writer proves that they use its
        // independent reader, not just that a routing attribute was attached.
        yield* Effect.gen(function* () {
          const snapshot = yield* projections.getThreadSnapshotWindow(threadId, { rowLimit: 75 });
          assert.equal(snapshot.projection.thread.title, "Committed");
          assert.equal(snapshot.snapshotSequence, sequence);
          assert.equal((yield* projections.getThreadShell(threadId, sequence))?.title, "Committed");
          assert.deepEqual(
            yield* projections.getLimitRecoveryCandidates({ now, autoResume: true, snooze: true }),
            [],
          );
          assert.deepEqual(yield* projections.getThreadsWithPullRequests(), []);
          const replay = yield* events.readAgentEvents({ threadId }).pipe(Stream.runCollect);
          assert.deepEqual(
            replay.map((stored) => stored.sequence),
            [sequence],
          );
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        const committedSequence = yield* Fiber.join(writer);
        const next = yield* projections.getThreadSnapshotWindow(threadId, { rowLimit: 75 });
        assert.equal(next.projection.thread.title, "Uncommitted");
        assert.equal(next.snapshotSequence, committedSequence);
        assert.equal(
          (yield* projections.getThreadShell(threadId, committedSequence))?.title,
          "Uncommitted",
        );
        const replay = yield* events
          .readAgentEvents({ threadId, throughSequence: committedSequence })
          .pipe(Stream.runCollect);
        assert.deepEqual(
          replay.map((stored) => stored.sequence),
          [sequence, committedSequence],
        );
      }),
    ),
);

it.effect(
  "shares concurrent and completed shell reads only for the same thread and committed sequence",
  () =>
    withFileStore(
      Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const sequence = yield* seed;
        let reads = 0;
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (time, exit) => {
              end(time, exit);
              const query = span.attributes.get("db.query.text");
              if (
                typeof query === "string" &&
                query.includes("AS forked_from_run_source_thread_id")
              )
                reads++;
            };
            return span;
          },
        });
        yield* Effect.gen(function* () {
          const shells = yield* Effect.all(
            Array.from({ length: 3 }, () => projections.getThreadShell(threadId, sequence)),
            { concurrency: "unbounded" },
          );
          assert.equal(reads, 1);
          assert.strictEqual(shells[0], shells[1]);
          assert.strictEqual(shells[1], shells[2]);
          assert.strictEqual(yield* projections.getThreadShell(threadId, sequence), shells[0]);
          assert.equal(reads, 1);
          assert.isNull(yield* projections.getThreadShell(ThreadId.make("unknown"), sequence));
          assert.equal(reads, 2);
          // Unsequenced control reads are always fresh, never a cached shell.
          yield* projections.getThreadShell(threadId);
          yield* projections.getThreadShell(threadId);
          assert.equal(reads, 4);
        }).pipe(Effect.withTracer(tracer));
      }),
    ),
);

it.effect(
  "nested reads bypass the shell cache, observe their writer's own changes and roll back with it",
  () =>
    withFileStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const events = yield* OrchestrationEventStore.OrchestrationEventStore;
        const sequence = yield* seed;
        assert.equal((yield* projections.getThreadShell(threadId, sequence))?.title, "Committed");
        const rolledBack = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const stored = yield* events.appendAgentEvents({ events: [changed] });
              yield* projections.apply(changed);
              assert.equal(
                (yield* projections.getThreadShell(threadId, sequence))?.title,
                "Uncommitted",
              );
              const snapshot = yield* projections.getThreadSnapshotWindow(threadId, {
                rowLimit: 75,
              });
              assert.equal(snapshot.projection.thread.title, "Uncommitted");
              assert.equal(snapshot.snapshotSequence, stored[0]!.sequence);
              assert.lengthOf(
                yield* events.readAgentEvents({ threadId }).pipe(Stream.runCollect),
                2,
              );
              return yield* Effect.fail("rollback");
            }),
          )
          .pipe(Effect.flip);
        assert.equal(rolledBack, "rollback");
        assert.equal((yield* projections.getThreadShell(threadId, sequence))?.title, "Committed");
        assert.equal((yield* projections.getThreadShell(threadId))?.title, "Committed");
        assert.lengthOf(yield* events.readAgentEvents({ threadId }).pipe(Stream.runCollect), 1);
      }),
    ),
);

it.effect("does not retain a failed shell read for a committed sequence", () =>
  withFileStore(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sequence = yield* seed;
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{}' WHERE thread_id = ${threadId}`;
      const error = yield* projections.getThreadShell(threadId, sequence).pipe(Effect.flip);
      assert.equal(error._tag, "ProjectionStoreReadError");
      yield* projections.apply(created);
      assert.equal((yield* projections.getThreadShell(threadId, sequence))?.title, "Committed");
    }),
  ),
);
