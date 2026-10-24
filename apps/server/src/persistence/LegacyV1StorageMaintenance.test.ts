import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@getpaperplane/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as LegacyV1StorageMaintenance from "./LegacyV1StorageMaintenance.ts";
import * as Sqlite from "./Sqlite.ts";

it.effect(
  "retires only dead tables after all imports; retries, rolls back and preserves readers",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dbPath = path.join(yield* fs.makeTempDirectoryScoped(), "statev2.sqlite");
      const database = Sqlite.layerFromPath(dbPath);
      const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
        Layer.provideMerge(database),
      );
      const sink = EventSink.layer.pipe(Layer.provide(stores));
      const services = Layer.mergeAll(
        LegacyV1StorageMaintenance.layer.pipe(Layer.provide(database)),
        LegacyV1ThreadImporter.layer.pipe(Layer.provide(Layer.merge(stores, sink))),
        ProjectionMaintenance.layer.pipe(Layer.provide(stores)),
        stores,
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const cleanup = yield* LegacyV1StorageMaintenance.LegacyV1StorageMaintenance;
        const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('project', 'Project', '/tmp/legacy', '[]', '2026-01-01', '2026-01-01')`;
        yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
        VALUES ('thread', 'project', 'Legacy', '{"instanceId":"pi","model":"test"}',
          'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
        yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('message', 'thread', 'user', 'Retained transcript', 0,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
        // An empty import ledger is not proof that every shell was imported.
        assert.isFalse(yield* cleanup.retire(dbPath));
        yield* importer.reconcileShells;
        assert.isFalse(yield* cleanup.retire(dbPath));
        yield* importer.importPendingTranscripts;
        assert.equal(yield* importer.pendingThreadCount, 0);
        const before = yield* projections.getThreadProjection(ThreadId.make("thread"));

        // A failure on the final DROP must undo all preceding DROPs.
        yield* sql`DROP TABLE checkpoint_diff_blobs`;
        yield* sql`CREATE VIEW checkpoint_diff_blobs AS SELECT 1`;
        assert.equal(
          (yield* cleanup.retire(dbPath).pipe(Effect.flip))._tag,
          "LegacyStorageCleanupError",
        );
        assert.lengthOf(yield* sql`SELECT * FROM projection_thread_activities`, 0);
        yield* sql`DROP VIEW checkpoint_diff_blobs`;
        yield* sql`CREATE TABLE checkpoint_diff_blobs (value TEXT)`;
        assert.isTrue(yield* cleanup.retire(dbPath));
        assert.isFalse(yield* cleanup.retire(dbPath));
        assert.isEmpty(
          yield* sql`SELECT name FROM sqlite_schema WHERE name IN (
        'projection_thread_activities', 'projection_turns', 'projection_pending_approvals',
        'projection_thread_proposed_plans', 'projection_state', 'checkpoint_diff_blobs',
        'idx_projection_thread_activities_thread_created')`,
        );
        // Startup migrations must not recreate retired tables or query them again.
        yield* Effect.gen(function* () {
          const reopened = yield* SqlClient.SqlClient;
          assert.isEmpty(
            yield* reopened`SELECT name FROM sqlite_schema WHERE name = 'projection_turns'`,
          );
        }).pipe(Effect.provide(Sqlite.layerFromPath(dbPath)));
        yield* importer.reconcileShells;
        yield* importer.ensureTranscript(ThreadId.make("thread"));
        yield* importer.importPendingTranscripts;
        assert.equal(yield* importer.pendingThreadCount, 0);
        assert.isTrue((yield* maintenance.rebuild).valid);
        assert.deepEqual(yield* projections.getThreadProjection(ThreadId.make("thread")), before);
        assert.lengthOf(yield* sql`SELECT * FROM projection_thread_messages`, 1);
        // Settings startup continues to use these historical provider sources.
        yield* sql`SELECT provider_name, provider_instance_id FROM projection_thread_sessions
        UNION SELECT provider_name, provider_instance_id FROM provider_session_runtime`;
        yield* sql`SELECT * FROM projection_projects`;
        yield* sql`SELECT * FROM projection_thread_pull_requests`;
      }).pipe(Effect.provide(services));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
