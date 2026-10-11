import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Recover ingestion order, not timestamp/UUID order. Existing provider sequences stay intact.
  yield* sql`
    WITH activity_order AS (
      SELECT stream_id, json_extract(payload_json, '$.activity.id') AS activity_id,
             MAX(sequence) AS sequence
      FROM orchestration_events
      WHERE event_type = 'thread.activity-appended'
      GROUP BY stream_id, json_extract(payload_json, '$.activity.id')
    )
    UPDATE projection_thread_activities AS activity
    SET sequence = event.sequence
    FROM activity_order AS event
    WHERE activity.sequence IS NULL
      AND event.stream_id = activity.thread_id
      AND event.activity_id = activity.activity_id
  `;
});
