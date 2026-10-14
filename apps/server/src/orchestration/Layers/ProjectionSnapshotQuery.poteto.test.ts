import { ThreadId } from "@rove-code/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(
    Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
      resolve: () => Effect.succeed(null),
    }),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
);

it.effect(
  "recovers only latest Poteto journals past the activity cap, including finished archived owners",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;
      const threadId = ThreadId.make("owner");
      yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, model_selection_json, created_at, updated_at, archived_at)
      VALUES ('owner', NULL, 'Owner', '{"instanceId":"codex","model":"fixture"}',
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
        ('other', NULL, 'Other', '{"instanceId":"codex","model":"fixture"}',
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL)`;
      for (const [id, sequence, kind, payload] of [
        ["old", 1, "poteto.requested", { runId: "old" }],
        ["request", 2, "poteto.requested", { runId: "latest", attemptId: "owner" }],
        [
          "journal",
          3,
          "poteto.event",
          { runId: "latest", event: { type: "snapshot", snapshot: "private-core" } },
        ],
        ["finish", 4, "poteto.finished", { runId: "latest", status: "blocked" }],
      ] as const) {
        const encoded = yield* encodePayload(payload);
        yield* sql`INSERT INTO projection_thread_activities
        (activity_id, thread_id, tone, kind, summary, payload_json, sequence, created_at)
        VALUES (${id}, ${threadId}, 'info', ${kind}, 'Poteto', ${encoded}, ${sequence}, '2026-01-01T00:00:00Z')`;
      }
      // Malformed unrelated payloads must not be decoded during engine startup.
      yield* sql`INSERT INTO projection_thread_activities
      (activity_id, thread_id, tone, kind, summary, payload_json, sequence, created_at)
      VALUES ('unrelated', 'other', 'info', 'generic', 'Other', 'not-json', 900, '2026-01-01T00:00:00Z')`;
      yield* sql`WITH RECURSIVE n(x) AS (SELECT 10 UNION ALL SELECT x+1 FROM n WHERE x < 610)
      INSERT INTO projection_thread_activities
      (activity_id, thread_id, tone, kind, summary, payload_json, sequence, created_at)
      SELECT 'noise-' || x, 'owner', 'info', 'generic', 'Noise', '{}', x, '2026-01-01T00:00:00Z' FROM n`;
      const command = yield* query.getCommandReadModel();
      const owner = command.threads.find((thread) => thread.id === threadId)!;
      assert.deepStrictEqual(
        owner.activities.map((activity) => activity.id),
        ["request", "journal", "finish"],
      );
      assert.deepStrictEqual(owner.activities[1]!.payload, {
        runId: "latest",
        event: { type: "snapshot", snapshot: "private-core" },
      });
      assert.deepStrictEqual(
        command.threads.find((thread) => thread.id === "other")!.activities,
        [],
      );
      yield* sql`UPDATE projection_threads SET archived_at = NULL WHERE thread_id = ${threadId}`;
      const detail = Option.getOrThrow(
        yield* query.getThreadDetailById(threadId, {
          activityKinds: ["poteto.requested", "poteto.control", "poteto.event", "poteto.finished"],
        }),
      );
      assert.deepStrictEqual(detail.activities, owner.activities);
      const ordinary = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
      assert.deepStrictEqual(
        ordinary.activities.filter((activity) => activity.kind.startsWith("poteto.")),
        owner.activities,
      );
      const client = Option.getOrThrow(yield* query.getThreadDetailSnapshot(threadId));
      assert.deepStrictEqual(
        client.thread.activities
          .filter((activity) => activity.kind.startsWith("poteto."))
          .map((activity) => activity.id),
        ["request", "journal", "finish"],
      );
    }).pipe(Effect.provide(layer)),
);
