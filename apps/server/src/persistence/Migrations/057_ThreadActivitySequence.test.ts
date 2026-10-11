import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@rove-code/shared/nodeSqliteClient";

import migrate from "./057_ThreadActivitySequence.ts";

const encodePayload = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ activity: Schema.Struct({ id: Schema.String }) })),
);

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("057_ThreadActivitySequence", (it) => {
  it.effect("recovers lifecycle order while preserving provider sequences and unmatched rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_thread_activities (activity_id TEXT PRIMARY KEY, thread_id TEXT, sequence INTEGER)`;
      yield* sql`CREATE TABLE orchestration_events (sequence INTEGER, stream_id TEXT, event_type TEXT, payload_json TEXT)`;
      for (const [id, sequence] of [
        ["z-progress", null],
        ["a-complete", null],
        ["provider", 7],
        ["unmatched", null],
      ] as const) {
        yield* sql`INSERT INTO projection_thread_activities VALUES (${id}, 'thread', ${sequence})`;
      }
      for (const [sequence, id] of [
        [9, "z-progress"],
        [10, "z-progress"],
        [11, "a-complete"],
        [12, "provider"],
      ] as const) {
        yield* sql`INSERT INTO orchestration_events VALUES (${sequence}, 'thread', 'thread.activity-appended', ${encodePayload({ activity: { id } })})`;
      }
      yield* migrate;
      yield* migrate;
      const rows = yield* sql<{ readonly activity_id: string; readonly sequence: number | null }>`
        SELECT activity_id, sequence FROM projection_thread_activities ORDER BY activity_id
      `;
      assert.deepEqual(rows, [
        { activity_id: "a-complete", sequence: 11 },
        { activity_id: "provider", sequence: 7 },
        { activity_id: "unmatched", sequence: null },
        { activity_id: "z-progress", sequence: 10 },
      ]);
    }),
  );
});
