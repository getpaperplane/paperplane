// @effect-diagnostics nodeBuiltinImport:off - Disposable prototype journal, not the live Rove database.
import * as NodeSqlite from "node:sqlite";
import * as Schema from "effect/Schema";
import { decodePotetoEvents, type PotetoEvent, type PotetoJournal } from "./PotetoMode.ts";
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** A separate SQLite file keeps the prototype off the application's event schema.
 * Production integration must move these events into the orchestration transaction.
 */
export function openPotetoModeJournal(path: string): PotetoJournal & { close: () => void } {
  const database = new NodeSqlite.DatabaseSync(path);
  database.exec(
    "CREATE TABLE IF NOT EXISTS poteto_events (sequence INTEGER PRIMARY KEY, data TEXT NOT NULL)",
  );
  const rows = database.prepare("SELECT data FROM poteto_events ORDER BY sequence");
  const insert = database.prepare("INSERT INTO poteto_events (sequence, data) VALUES (?, ?)");
  const count = database.prepare("SELECT COUNT(*) AS count FROM poteto_events");
  const decodeRows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ data: Schema.String })));
  const decodeCount = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }));
  return {
    read: () => decodePotetoEvents(decodeRows(rows.all()).map((row) => parseJson(row.data))),
    append: (expectedLength: number, event: PotetoEvent) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        if (decodeCount(count.get()).count !== expectedLength)
          throw new Error("Stale Poteto Mode owner. Reload the journal.");
        insert.run(expectedLength, JSON.stringify(event));
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => database.close(),
  };
}
