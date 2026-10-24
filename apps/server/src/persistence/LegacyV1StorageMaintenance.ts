import * as NodeWorkerThreads from "node:worker_threads";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class LegacyStorageCleanupError extends Schema.TaggedError<LegacyStorageCleanupError>()(
  "LegacyStorageCleanupError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not retire imported legacy database tables.";
  }
}

export class LegacyV1StorageMaintenance extends Context.Service<
  LegacyV1StorageMaintenance,
  {
    readonly retire: (databasePath: string) => Effect.Effect<boolean, LegacyStorageCleanupError>;
  }
>()("@getpaperplane/server/persistence/LegacyV1StorageMaintenance") {}

// These tables have no runtime readers after v1 migrations. Keep projects,
// threads, messages and pull requests for shell repair/transcript import, and
// sessions/provider_session_runtime for settings history. orchestration_events
// and orchestration_command_receipts are SHARED with v2; history compaction
// already removes their imported v1 rows in bounded batches.
const retiredTables = [
  "projection_thread_activities",
  "projection_turns",
  "projection_pending_approvals",
  "projection_thread_proposed_plans",
  "projection_state",
  "checkpoint_diff_blobs",
];

// Evaluated source works in bundled desktop/CLI builds without a worker asset.
// DROP of a large table can take seconds even without VACUUM. It must not run
// on the synchronous SQLite connection on the server's event loop. The guard
// mirrors LegacyV1ThreadImporter's pendingThreadCount, including skipped shells.
const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.databasePath);
try {
  db.exec("PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON");
  const remaining = workerData.tables.filter(name =>
    db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(name));
  if (remaining.length === 0) {
    parentPort.postMessage(false);
  } else {
    db.exec("BEGIN IMMEDIATE");
    try {
      const pending = db.prepare(\`
        SELECT 1 FROM orchestration_v2_legacy_imports
        WHERE transcript_imported_at IS NULL
        UNION ALL
        SELECT 1 FROM projection_threads AS thread
        WHERE NOT EXISTS (
          SELECT 1 FROM orchestration_events AS event INDEXED BY orchestration_events_v2_created_threads_idx
          WHERE event.application_event_version = 2
            AND event.aggregate_kind = 'thread'
            AND event.stream_id = thread.thread_id
            AND event.event_type = 'thread.created'
        )
        LIMIT 1
      \`).get();
      if (!pending) {
        for (const table of remaining) db.exec('DROP TABLE IF EXISTS "' + table + '"');
      }
      db.exec("COMMIT");
      parentPort.postMessage(!pending);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
} finally {
  db.close();
}
`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const retire = Effect.fn("LegacyV1StorageMaintenance.retire")(
    function* (databasePath: string) {
      if (databasePath === ":memory:" || databasePath === "") return false;
      // Reserve, but do not BEGIN on, the server's writer. Other writes wait
      // asynchronously rather than blocking the event loop in busy_timeout
      // while the worker owns SQLite's write lock. WAL readers can continue.
      yield* sql.reserve;
      return yield* Effect.acquireUseRelease(
        Effect.try(
          () =>
            new NodeWorkerThreads.Worker(workerSource, {
              eval: true,
              workerData: { databasePath, tables: retiredTables },
            }),
        ),
        (worker) =>
          Effect.callback<boolean, LegacyStorageCleanupError>((resume) => {
            worker.once("message", (changed: boolean) => resume(Effect.succeed(changed)));
            worker.once("error", (cause) =>
              resume(Effect.fail(new LegacyStorageCleanupError({ cause }))),
            );
            worker.once("exit", (code) =>
              resume(
                Effect.fail(
                  new LegacyStorageCleanupError({
                    cause: new Error(`Legacy cleanup worker exited without a result (${code}).`),
                  }),
                ),
              ),
            );
          }),
        // Keep the reservation through termination, including cancellation.
        (worker) => Effect.promise(() => worker.terminate()),
      );
    },
    Effect.scoped,
    Effect.mapError((cause) =>
      Schema.is(LegacyStorageCleanupError)(cause)
        ? cause
        : new LegacyStorageCleanupError({ cause }),
    ),
  );
  return LegacyV1StorageMaintenance.of({ retire });
});

export const layer = Layer.effect(LegacyV1StorageMaintenance, make);
