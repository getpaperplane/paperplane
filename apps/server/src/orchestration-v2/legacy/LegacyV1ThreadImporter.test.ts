import { assert, it } from "@effect/vitest";
import { EventId, ProviderInstanceId, ThreadId } from "@getpaperplane/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { listLinkedPullRequestThreads } from "../../pullRequest/linkedThreads.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import * as ProjectionStore from "../ProjectionStore.ts";

const layerDatabase = SqlitePersistence.layerMemory;
const layerEventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(layerDatabase));
const layerProjectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase));
const layerStoresProvided = Layer.mergeAll(
  layerDatabase,
  layerEventStoreProvided,
  layerProjectionStoreProvided,
);
const layerEventSinkProvided = EventSink.layer.pipe(Layer.provide(layerStoresProvided));
const layerImporterProvided = LegacyV1ThreadImporter.layer.pipe(
  Layer.provide(Layer.mergeAll(layerStoresProvided, layerEventSinkProvided)),
);
const layerProjectionMaintenanceProvided = ProjectionMaintenance.layer.pipe(
  Layer.provide(layerStoresProvided),
);
const layerTest = Layer.mergeAll(
  layerStoresProvided,
  layerEventSinkProvided,
  layerImporterProvided,
  layerProjectionMaintenanceProvided,
);

// Reproduce Paperplane migration 056's nullable ownership without re-registering it.
const standaloneLegacySchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  if (columns.some((column) => column.name === "workspace_path")) return;
  const [table] = yield* sql<{ readonly sql: string }>`
    SELECT sql FROM sqlite_master WHERE name = 'projection_threads' AND type = 'table'
  `;
  assert.isDefined(table);
  yield* sql.unsafe(
    table!.sql
      .replace(/\bprojection_threads\b/, "projection_threads_standalone")
      .replace(/project_id TEXT NOT NULL/i, "project_id TEXT"),
  );
  yield* sql`DROP TABLE projection_threads`;
  yield* sql`ALTER TABLE projection_threads_standalone RENAME TO projection_threads`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN workspace_path TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN limit_recovery_json TEXT`;
});

const seedLegacyThread = (input: {
  readonly id: string;
  readonly projectId?: string | null;
  readonly workspacePath?: string | null;
  readonly createdAt?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, workspace_path, title, model_selection_json,
      runtime_mode, interaction_mode, created_at, updated_at, limit_recovery_json
    ) VALUES (
      ${input.id}, ${input.projectId ?? null}, ${input.workspacePath ?? null},
      'Legacy thread',
      '{"instanceId":"pi_pi_personal","model":"openai-codex/custom-model","options":[{"id":"thinkingLevel","value":"max"}]}',
      'full-access', 'default', ${input.createdAt ?? "2026-01-01T00:00:00.000Z"},
      '2026-01-02T00:00:00.000Z', '{"status":"scheduled"}'
    )
  `;
  });

it.layer(layerTest)("Paperplane V1 compatibility", (it) => {
  it.effect("preserves standalone history under existing or replayable workspace projects", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      yield* standaloneLegacySchema;
      yield* sql`
        INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('project:existing', 'Existing', '/tmp/existing/', '[]',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      yield* seedLegacyThread({ id: "standalone:reuse", workspacePath: " /tmp/existing " });
      yield* seedLegacyThread({ id: "standalone:new", workspacePath: "/tmp/new-workspace" });
      yield* seedLegacyThread({
        id: "standalone:shared",
        projectId: " ",
        workspacePath: "/tmp/new-workspace/",
      });
      yield* sql`
        UPDATE projection_threads
        SET settled_override = 'settled', settled_at = '2026-01-02T00:00:00.000Z',
          auto_settle_disabled_at = '2026-01-01T00:00:00.000Z'
        WHERE thread_id = 'standalone:new'
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, attachments_json, is_streaming, created_at, updated_at
        ) VALUES ('standalone:message', 'standalone:new', 'assistant', 'Preserved history', '[]', 0,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 3,
        importedMessageCount: 1,
        importedProjectCount: 1,
      });
      const reused = yield* projections.getThreadProjection(ThreadId.make("standalone:reuse"));
      const created = yield* projections.getThreadProjection(ThreadId.make("standalone:new"));
      const shared = yield* projections.getThreadProjection(ThreadId.make("standalone:shared"));
      assert.equal(reused.thread.projectId, "project:existing");
      assert.equal(created.thread.projectId, shared.thread.projectId);
      assert.equal(created.thread.settledOverride, "settled");
      assert.deepStrictEqual(
        created.thread.settledAt,
        DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      );
      assert.deepStrictEqual(
        created.thread.autoSettleDisabledAt,
        DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
      );
      assert.equal(created.thread.providerInstanceId, ProviderInstanceId.make("pi_pi_personal"));
      assert.deepStrictEqual(created.thread.modelSelection, {
        instanceId: ProviderInstanceId.make("pi_pi_personal"),
        model: "openai-codex/custom-model",
        options: [{ id: "thinkingLevel", value: "max" }],
      });
      const [project] = yield* sql<{ readonly title: string; readonly workspace_root: string }>`
        SELECT title, workspace_root FROM projection_projects WHERE project_id = ${created.thread.projectId}
      `;
      assert.deepStrictEqual(project, {
        title: "new-workspace",
        workspace_root: "/tmp/new-workspace",
      });
      yield* importer.importPendingTranscripts;
      assert.equal(yield* importer.pendingThreadCount, 0);
      assert.equal(created.messages[0]?.text, "Preserved history");
      assert.isEmpty(created.runs);
      assert.isEmpty(created.providerThreads);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepStrictEqual(
        (yield* projections.getThreadProjection(ThreadId.make("standalone:new"))).thread,
        created.thread,
      );
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });
      const [legacy] = yield* sql<{
        readonly project_id: string | null;
        readonly workspace_path: string;
      }>`
        SELECT project_id, workspace_path FROM projection_threads WHERE thread_id = 'standalone:new'
      `;
      assert.isNull(legacy?.project_id);
      assert.equal(legacy?.workspace_path, "/tmp/new-workspace");
    }),
  );

  it.effect(
    "warns and skips bad rows without losing good messages or replaying fork-only events",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* standaloneLegacySchema;
        yield* seedLegacyThread({ id: "bad:no-workspace" });
        yield* seedLegacyThread({ id: "bad:blank-workspace", projectId: " ", workspacePath: " " });
        yield* seedLegacyThread({ id: "bad:relative-workspace", workspacePath: "relative/path" });
        yield* seedLegacyThread({
          id: "bad:date",
          workspacePath: "/tmp/bad",
          createdAt: "not-a-date",
        });
        yield* seedLegacyThread({ id: "", workspacePath: "/tmp/bad-id" });
        yield* seedLegacyThread({ id: "good", workspacePath: "/tmp/good" });
        yield* sql`
        UPDATE projection_threads SET model_selection_json = 'invalid', linked_pull_request_json = 'invalid'
        WHERE thread_id = 'good'
      `;
        yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, context_json, attachments_json, is_streaming, created_at, updated_at
        ) VALUES
          ('older', 'good', 'assistant', 'Older history', NULL, '[]', 0,
            '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'),
          ('bad-message', 'good', 'user', 'Bad timestamp', NULL, '[]', 0,
            '2026-01-01T00:00:00.000Z', 'invalid'),
          ('latest', 'good', 'assistant', ${'```paperplane-response\n{"type":"table"}\n```'}, '{"forkOnly":"value"}', 'invalid', 0,
            '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
      `;
        yield* sql`
        INSERT INTO projection_thread_pull_requests (
          thread_id, host, repository, number, url, source, linked_at, snapshot_json, stack_json
        ) VALUES ('good', 'github.com', 'hafiezul/rove', 234,
          'https://github.com/hafiezul/rove/pull/234', 'manual',
          '2026-01-01T00:00:00.000Z', 'invalid', 'invalid')
      `;
        yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json
        ) VALUES ('fork-only', 'thread', 'good', 0, 'thread.poteto-started',
          '2026-01-01T00:00:00.000Z', 'server', '{"forkOnly":"value"}', '{}')
      `;
        const warnings: unknown[] = [];
        const logger = Logger.make(({ message }) => {
          warnings.push(message);
        });
        const withLogs = Effect.provideService(Logger.CurrentLoggers, new Set([logger]));
        assert.deepStrictEqual(yield* importer.reconcileShells.pipe(withLogs), {
          importedThreadCount: 1,
          importedMessageCount: 1,
          importedProjectCount: 1,
          skippedThreadCount: 5,
          skippedMessageCount: 1,
        });
        assert.deepStrictEqual(yield* importer.importPendingTranscripts.pipe(withLogs), {
          importedThreadCount: 1,
          importedMessageCount: 1,
          skippedMessageCount: 1,
        });
        assert.lengthOf(warnings, 7);
        const good = yield* projections.getThreadProjection(ThreadId.make("good"));
        assert.deepStrictEqual(
          good.messages.map((message) => message.id),
          ["older", "latest"],
        );
        assert.include(good.messages[1]!.text, "paperplane-response");
        assert.deepStrictEqual(good.messages[1]!.attachments, []);
        assert.isUndefined(good.messages[1]!.context);
        assert.isNull(good.thread.linkedPullRequest);
        assert.equal(good.thread.pullRequests?.[0]?.number, 234);
        assert.isNull(good.thread.pullRequests?.[0]?.snapshot);
        assert.isNull(good.thread.pullRequests?.[0]?.stack);
        assert.equal(good.thread.providerInstanceId, "codex");
        assert.isEmpty(good.runs);
        assert.isEmpty(good.providerThreads);
        assert.isEmpty(good.turnItems.filter((item) => item.type !== "assistant_message"));
        const [progress] = yield* sql<{
          readonly imported_message_count: number;
          readonly transcript_imported_at: string | null;
        }>`
        SELECT imported_message_count, transcript_imported_at FROM orchestration_v2_legacy_imports WHERE thread_id = 'good'
      `;
        assert.equal(progress?.imported_message_count, 2);
        assert.isNotNull(progress?.transcript_imported_at);
        const [source] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_threads
        WHERE thread_id IN ('bad:no-workspace', 'bad:blank-workspace', 'bad:relative-workspace', 'bad:date', '', 'good')
      `;
        assert.equal(source?.count, 6);
      }),
  );
});

it.layer(layerTest)("LegacyV1ThreadImporter", (it) => {
  it.effect("uses the created-thread index for startup migration checks", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const statements: string[] = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            const query = span.attributes.get("db.query.text");
            if (
              typeof query === "string" &&
              query.includes("FROM projection_threads AS thread") &&
              query.includes("FROM orchestration_events AS event")
            ) {
              statements.push(query);
            }
          };
          return span;
        },
      });

      assert.equal(yield* importer.pendingThreadCount.pipe(Effect.withTracer(tracer)), 0);
      assert.deepStrictEqual(yield* importer.reconcileShells.pipe(Effect.withTracer(tracer)), {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });
      assert.lengthOf(statements, 2);
      for (const statement of statements) {
        const plan = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${statement}`,
        );
        assert.match(
          plan.map((row) => row.detail).join("\n"),
          /SEARCH event USING INDEX orchestration_events_v2_created_threads_idx \(stream_id=\?\)/,
        );
      }
    }),
  );

  it.effect("imports lightweight shells, hydrates transcripts, and remains idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:legacy-import");

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          'project:legacy-import',
          'Legacy project',
          '/tmp/legacy-project',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          unsettled_at,
          snoozed_until,
          snoozed_at,
          pinned_at,
          pin_order_key,
          linked_pull_request_json,
          deleted_at
        ) VALUES (
          ${threadId},
          'project:legacy-import',
          'Migrated conversation',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          ' main ',
          ' /tmp/legacy-project ',
          NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL,
          NULL,
          NULL,
          '2026-01-03T12:00:00.000Z',
          '2026-02-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          'm',
          '{"projectId":"project:legacy-import","repository":"pingdotgg/t3code","number":9000,"url":"https://github.com/pingdotgg/t3code/pull/9000"}',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        ) VALUES
          (
            'message:legacy:1',
            ${threadId},
            NULL,
            'user',
            'First question',
            '[]',
            0,
            '2026-01-01T01:00:00.000Z',
            '2026-01-01T01:00:00.000Z'
          ),
          (
            'message:legacy:2',
            ${threadId},
            NULL,
            'assistant',
            'First answer',
            '[]',
            0,
            '2026-01-02T01:00:00.000Z',
            '2026-01-02T01:00:00.000Z'
          ),
          (
            'message:legacy:3',
            ${threadId},
            NULL,
            'user',
            'Follow-up question',
            '[]',
            0,
            '2026-01-03T01:00:00.000Z',
            '2026-01-03T01:00:00.000Z'
          ),
          (
            'message:legacy:4',
            ${threadId},
            NULL,
            'assistant',
            'Partial answer',
            '[]',
            1,
            '2026-01-04T01:00:00.000Z',
            '2026-01-04T01:00:00.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_pull_requests (
          thread_id, host, repository, number, url, source, linked_at, snapshot_json
        ) VALUES
          (${threadId}, 'github.com', 'pingdotgg/t3code', 9002,
            'https://github.com/pingdotgg/t3code/pull/9002', 'created',
            '2026-01-03T00:00:00.000Z',
            '{"state":"open","title":"Second PR","headBranch":"feature-two","baseBranch":"main","isDraft":false,"updatedAt":"2026-01-03T00:00:00.000Z","syncedAt":"2026-01-03T00:00:00.000Z"}'),
          (${threadId}, 'github.com', 'pingdotgg/t3code', 9003,
            'https://github.com/pingdotgg/t3code/pull/9003', 'manual',
            '2026-01-04T00:00:00.000Z', NULL)
      `;

      assert.equal(yield* importer.pendingThreadCount, 1);
      const shellImport = yield* importer.reconcileShells;
      assert.equal(yield* importer.pendingThreadCount, 1);
      assert.deepStrictEqual(shellImport, {
        importedThreadCount: 1,
        importedMessageCount: 2,
      });
      const shellEventCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.equal(shellEventCount[0]?.count, 6);

      assert.isTrue((yield* maintenance.verify).valid);
      const shellProjection = yield* projections.getThreadProjection(threadId);
      assert.equal(shellProjection.thread.historyOrigin, "v1_import");
      assert.equal(shellProjection.thread.branch, "main");
      assert.equal(shellProjection.thread.worktreePath, "/tmp/legacy-project");
      assert.deepEqual(
        shellProjection.thread.pinnedAt,
        DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      );
      assert.equal(shellProjection.thread.pinOrderKey, "m");
      assert.deepEqual(
        shellProjection.thread.snoozedUntil,
        DateTime.makeUnsafe("2026-02-01T00:00:00.000Z"),
      );
      assert.deepEqual(
        shellProjection.thread.unsettledAt,
        DateTime.makeUnsafe("2026-01-03T12:00:00.000Z"),
      );
      assert.equal(shellProjection.thread.linkedPullRequest?.number, 9000);
      assert.deepStrictEqual(
        (shellProjection.thread.pullRequests ?? []).map((link) => link.number),
        [9002, 9003, 9000],
      );
      assert.equal(shellProjection.thread.pullRequests?.[0]?.snapshot?.title, "Second PR");
      assert.deepStrictEqual(
        (yield* listLinkedPullRequestThreads({
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 9002,
        })).threads.map((thread) => thread.id),
        [threadId],
      );
      const shellSnapshot = yield* projections.getShellSnapshot();
      assert.equal(
        shellSnapshot.threads.find((thread) => thread.id === threadId)?.historyOrigin,
        "v1_import",
      );
      assert.deepStrictEqual(
        shellProjection.messages.map((message) => message.id),
        ["message:legacy:3", "message:legacy:4"],
      );

      const renamedAt = DateTime.makeUnsafe("2026-01-05T00:00:00.000Z");
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:legacy-import:metadata-after-shell"),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: shellProjection.thread.providerInstanceId,
            occurredAt: renamedAt,
            payload: {
              ...shellProjection.thread,
              title: "Renamed after shell import",
              runtimeMode: "approval-required",
              interactionMode: "plan",
              archivedAt: renamedAt,
              settledOverride: "settled",
              settledAt: renamedAt,
              updatedAt: renamedAt,
            },
          },
        ],
      });

      const transcriptImport = yield* importer.ensureTranscript(threadId);
      assert.equal(yield* importer.pendingThreadCount, 0);
      assert.deepStrictEqual(transcriptImport, {
        importedThreadCount: 1,
        importedMessageCount: 2,
      });
      const projection = yield* projections.getThreadProjection(threadId);
      assert.equal(projection.thread.title, "Renamed after shell import");
      assert.equal(projection.thread.runtimeMode, "approval-required");
      assert.equal(projection.thread.interactionMode, "plan");
      assert.deepEqual(projection.thread.archivedAt, renamedAt);
      assert.equal(projection.thread.settledOverride, "settled");
      assert.deepEqual(projection.thread.settledAt, renamedAt);
      assert.deepStrictEqual(
        projection.messages.map((message) => message.id),
        ["message:legacy:1", "message:legacy:2", "message:legacy:3", "message:legacy:4"],
      );
      assert.deepStrictEqual(
        projection.turnItems
          .filter(
            (
              item,
            ): item is Extract<
              (typeof projection.turnItems)[number],
              { readonly type: "user_message" | "assistant_message" }
            > => item.type === "user_message" || item.type === "assistant_message",
          )
          .map((item) => [item.messageId, item.ordinal, item.status]),
        [
          ["message:legacy:1", 1, "completed"],
          ["message:legacy:2", 2, "completed"],
          ["message:legacy:3", 3, "completed"],
          ["message:legacy:4", 4, "interrupted"],
        ],
      );

      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:legacy-import:explicit-unpin"),
            type: "thread.unpinned",
            threadId,
            providerInstanceId: projection.thread.providerInstanceId,
            occurredAt: renamedAt,
            payload: { ...projection.thread, pinnedAt: null, pinOrderKey: null },
          },
        ],
      });
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_remove(
          payload_json,
          '$.snoozedUntil',
          '$.snoozedAt',
          '$.unsettledAt',
          '$.linkedPullRequest',
          '$.pullRequests'
        )
        WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 1,
        importedMessageCount: 0,
      });
      const repaired = yield* projections.getThreadProjection(threadId);
      assert.isNull(repaired.thread.pinnedAt);
      assert.isNull(repaired.thread.pinOrderKey);
      assert.deepEqual(
        repaired.thread.snoozedUntil,
        DateTime.makeUnsafe("2026-02-01T00:00:00.000Z"),
      );
      assert.deepEqual(
        repaired.thread.unsettledAt,
        DateTime.makeUnsafe("2026-01-03T12:00:00.000Z"),
      );
      assert.equal(repaired.thread.linkedPullRequest?.number, 9000);
      assert.deepStrictEqual(
        (repaired.thread.pullRequests ?? []).map((link) => link.number),
        [9002, 9003, 9000],
      );
      assert.equal(repaired.thread.pullRequests?.[0]?.snapshot?.title, "Second PR");
      const eventCountBeforeRetry = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });
      assert.deepStrictEqual(yield* importer.ensureTranscript(threadId), {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });
      const eventCountAfterRetry = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.equal(eventCountAfterRetry[0]?.count, eventCountBeforeRetry[0]?.count);
    }),
  );

  it.effect("repairs newly added metadata after an earlier metadata repair", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:legacy-metadata-upgrade");
      const previousRepairId = EventId.make(`migration:v1:thread:${threadId}:metadata-repair`);

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'project:legacy-metadata-upgrade',
          'Legacy project',
          '/tmp/legacy-metadata-upgrade',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, pinned_at, pin_order_key,
          linked_pull_request_json, branch_pull_request_json, active_order_key
        ) VALUES (
          ${threadId},
          'project:legacy-metadata-upgrade',
          'Original v1 title',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          'm',
          '{"projectId":"project:legacy-metadata-upgrade","repository":"pingdotgg/t3code","number":9000,"url":"https://github.com/pingdotgg/t3code/pull/9000"}',
          '{"projectId":"project:legacy-metadata-upgrade","repository":"pingdotgg/t3code","number":9001,"url":"https://github.com/pingdotgg/t3code/pull/9001"}',
          'az'
        )
      `;
      yield* importer.reconcileShells;
      yield* maintenance.rebuild;
      const shellProjection = yield* projections.getThreadProjection(threadId);
      assert.deepStrictEqual(
        (shellProjection.thread.pullRequests ?? []).map((link) => link.number),
        [9000],
      );
      const previousRepairThread = {
        ...shellProjection.thread,
        title: "Renamed in v2",
        pinnedAt: null,
        pinOrderKey: null,
        linkedPullRequest: null,
        pullRequests: [],
      };
      delete previousRepairThread.branchPullRequest;
      delete previousRepairThread.activeOrderKey;
      yield* eventSink.write({
        events: [
          {
            id: previousRepairId,
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: previousRepairThread.providerInstanceId,
            occurredAt: DateTime.makeUnsafe("2026-01-03T00:00:00.000Z"),
            payload: previousRepairThread,
          },
        ],
      });

      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 1,
        importedMessageCount: 0,
      });
      const repaired = yield* projections.getThreadProjection(threadId);
      assert.equal(repaired.thread.title, "Renamed in v2");
      assert.isNull(repaired.thread.pinnedAt);
      assert.isNull(repaired.thread.pinOrderKey);
      assert.isNull(repaired.thread.linkedPullRequest);
      assert.deepStrictEqual(repaired.thread.pullRequests, []);
      assert.equal(repaired.thread.branchPullRequest?.number, 9001);
      assert.equal(repaired.thread.activeOrderKey, "az");

      const eventsBeforeRetry = yield* sql<{ readonly event_id: string }>`
        SELECT event_id
        FROM orchestration_events
        WHERE application_event_version = 2 AND stream_id = ${threadId}
        ORDER BY sequence
      `;
      assert.equal(eventsBeforeRetry.length, 4);
      assert.isTrue(eventsBeforeRetry.some((event) => event.event_id === previousRepairId));
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });

      assert.isTrue((yield* maintenance.rebuild).valid);
      const replayed = yield* projections.getThreadProjection(threadId);
      assert.deepStrictEqual(replayed.thread, repaired.thread);
      assert.deepStrictEqual(
        yield* Effect.gen(function* () {
          const restartedImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
          return yield* restartedImporter.reconcileShells;
        }).pipe(Effect.provide(LegacyV1ThreadImporter.layer)),
        { importedThreadCount: 0, importedMessageCount: 0 },
      );
      const eventsAfterRestart = yield* sql<{ readonly event_id: string }>`
        SELECT event_id
        FROM orchestration_events
        WHERE application_event_version = 2 AND stream_id = ${threadId}
        ORDER BY sequence
      `;
      assert.deepStrictEqual(eventsAfterRestart, eventsBeforeRetry);
    }),
  );
});
