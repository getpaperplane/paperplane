/**
 * File-backed WAL contention workload using the real event store/projections.
 * Run from the repo root: node apps/server/scripts/perf/read-contention.ts
 * Optional: --events=400 --rows=3000 --rounds=3 (defaults below).
 * Timers pace benchmark traffic, not synchronization or test assertions. Each
 * round drains every accepted write/read before releasing its temporary DB.
 * Reports semaphore wait from NodeSqliteClient's existing transaction spans;
 * this is not SQLite's cross-process busy time or event-loop blocked time.
 * Ingest latency includes deadline-to-commit event-loop scheduling delay.
 *
 * Baseline, unmodified server at 0be564fcce,
 * Node 26.7.0 / darwin arm64; 200 events, 3000 rows, 3 rounds (median):
 * subscribers | ingest p50/p99 ms | loop p99 ms | writer wait ms | writer tx
 *           1 |     2.861 / 8.899 |       4.694 |          1.926 |       600
 *           3 |     2.858 / 8.826 |       5.374 |          1.991 |      1000
 * Main-thread reads usually finish without yielding in this workload, so their
 * blocking appears in latency/loop delay rather than semaphore wait. No busy
 * external writer or disk fault is simulated. Absolute timings are advisory.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as pace } from "node:timers/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@rove-code/contracts";
import * as NodeSqliteClient from "@rove-code/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";
import * as OrchestrationEventStore from "../../src/persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../../src/persistence/Sqlite.ts";
import * as ProjectionStore from "../../src/orchestration-v2/ProjectionStore.ts";

const option = (name: string, fallback: number) => {
  const value = Number(
    process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback,
  );
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid --${name}`);
  return value;
};
const events = option("events", 200);
const rows = option("rows", 3000);
const rounds = option("rounds", 3);
const periodMs = 50; // 20 events/s, one snapshot read and N shell reads per commit.
const threadId = ThreadId.make("thread:read-contention");
const providerInstanceId = ProviderInstanceId.make("codex");
const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");

const create: OrchestrationV2DomainEvent = {
  id: EventId.make("event:contention:create"),
  type: "thread.created",
  threadId,
  occurredAt: now,
  payload: {
    id: threadId,
    projectId: ProjectId.make("project:contention"),
    title: "Read contention",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
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
const item = (index: number, streaming = false): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:contention:${streaming ? "stream" : "seed"}:${index}`),
  type: "turn-item.updated",
  threadId,
  occurredAt: now,
  payload: {
    id: TurnItemId.make(streaming ? "item:streaming" : `item:${index}`),
    type: "command_execution",
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: streaming ? rows + 1 : index + 1,
    status: streaming ? "running" : "completed",
    title: "Command",
    input: "echo benchmark",
    output: streaming ? `chunk ${index}` : "x".repeat(12_000),
    ...(streaming ? {} : { exitCode: 0 }),
    startedAt: now,
    completedAt: streaming ? null : now,
    updatedAt: now,
  },
});
const percentile = (values: number[], quantile: number) => {
  const sorted = values.toSorted((a, b) => a - b);
  return Number((sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0).toFixed(3));
};

async function run(subscribers: number, round: number) {
  const directory = await mkdtemp(join(tmpdir(), "rove-read-contention-"));
  const persistence = SqlitePersistence.layerFromPath(join(directory, "state.sqlite")).pipe(
    Layer.provide(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(ProjectionStore.layer, OrchestrationEventStore.layer).pipe(
      Layer.provideMerge(persistence),
    ),
  );
  try {
    const context = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const store = yield* OrchestrationEventStore.OrchestrationEventStore;
        const ingest = (event: OrchestrationV2DomainEvent) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const stored = yield* store.appendAgentEvents({ events: [event] });
              yield* projections.apply(event);
              return stored[0]!;
            }),
          );
        yield* ingest(create);
        // Small batches keep the fixture from retaining the whole 36 MB of JSON.
        for (let first = 0; first < rows; first += 100) {
          yield* sql.withTransaction(
            Effect.forEach(
              Array.from({ length: Math.min(100, rows - first) }, (_, offset) =>
                item(first + offset),
              ),
              (event) => projections.apply(event),
              { discard: true },
            ),
          );
        }
        yield* projections.getThreadSnapshotWindow(threadId, { rowLimit: 75 });
        yield* projections.getThreadShell(threadId);
        // Start the worker even on baseline, so startup is excluded from both.
        yield* sql`SELECT 1`.pipe(NodeSqliteClient.readOnly);
        const mode = yield* sql<{ journal_mode: string }>`PRAGMA journal_mode`;
        if (mode[0]?.journal_mode !== "wal") throw new Error("Expected file-backed WAL");
        return { ingest, projections, store };
      }),
    );
    // An optional sequence is ignored by baseline; the fixed service shares it.
    const readShell: (
      threadId: ThreadId,
      sequence?: number,
    ) => ReturnType<typeof context.projections.getThreadShell> = context.projections.getThreadShell;
    const latencies: number[] = [];
    let writerWaitMs = 0;
    let writerTransactions = 0;
    let readerTransactions = 0;
    let measured = false;
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (time, exit) => {
          end(time, exit);
          if (!measured || span.name !== "sql.transaction") return;
          if (span.attributes.get("db.connection") === "writer") {
            writerTransactions++;
            writerWaitMs += Number(span.attributes.get("db.lock_wait_ms") ?? 0);
          } else if (span.attributes.get("db.connection") === "reader") readerTransactions++;
        };
        return span;
      },
    });
    const execute = <A, E>(effect: Effect.Effect<A, E>) =>
      runtime.runPromise(effect.pipe(Effect.withTracer(tracer)));
    const delay = monitorEventLoopDelay({ resolution: 1 });
    const pending = new Set<Promise<void>>();
    const failures: unknown[] = [];
    const track = (work: Promise<void>) => {
      const accepted = work.catch((cause: unknown) => {
        failures.push(cause);
      });
      pending.add(accepted);
      void accepted.finally(() => pending.delete(accepted));
    };
    delay.enable();
    measured = true;
    const start = performance.now();
    for (let index = 0; index < events; index++) {
      await pace(Math.max(0, start + index * periodMs - performance.now()));
      const scheduledAt = start + index * periodMs;
      // A cold-open/fallback reader is independent of event ingestion. Enqueue
      // it first at the same cadence to exercise contention, not only idle gaps.
      track(
        execute(context.projections.getThreadSnapshotWindow(threadId, { rowLimit: 75 })).then(
          () => {},
        ),
      );
      track(
        execute(context.ingest(item(index, true))).then(async (stored) => {
          latencies.push(performance.now() - scheduledAt);
          // Publication is after commit, like EventSink.commitThenPublish.
          await execute(context.store.publishCommitted([stored]));
          await execute(
            Effect.all(
              [...Array.from({ length: subscribers }, () => readShell(threadId, stored.sequence))],
              { concurrency: "unbounded", discard: true },
            ),
          );
        }),
      );
    }
    await Promise.all(pending);
    measured = false;
    delay.disable();
    if (failures.length) throw new AggregateError(failures, "Workload failed");
    const result = {
      subscribers,
      round,
      events,
      seedRows: rows,
      periodMs,
      elapsedMs: Number((performance.now() - start).toFixed(3)),
      ingestP50Ms: percentile(latencies, 0.5),
      ingestP99Ms: percentile(latencies, 0.99),
      eventLoopP99Ms: Number((delay.percentile(99) / 1e6).toFixed(3)),
      writerLockWaitMs: Number(writerWaitMs.toFixed(3)),
      writerTransactions,
      readerTransactions,
    };
    console.log(JSON.stringify(result));
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    events,
    rows,
    rounds,
  }),
);
for (let round = 1; round <= rounds; round++) {
  for (const subscribers of [1, 3]) await run(subscribers, round);
}
