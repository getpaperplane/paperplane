import { ThreadId } from "@rove-code/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import {
  ReadThreadHistoryInput,
  ThreadHistoryError,
  ThreadHistoryItem,
  ThreadHistoryResult,
  ThreadHistoryToolkit,
} from "./tools.ts";

const PAGE_SIZE = 10;
const TEXT_PAGE_SIZE = 8_000;
const isThreadHistoryError = Schema.is(ThreadHistoryError);
const ItemRow = ThreadHistoryItem.mapFields(Struct.assign({ isStreaming: Schema.Number }));

export const ThreadHistoryToolkitHandlersLive = ThreadHistoryToolkit.toLayer(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const getThread = SqlSchema.findOneOption({
      Request: ThreadId,
      Result: ThreadHistoryResult.fields.thread,
      execute: (threadId) => sql`
        SELECT thread_id AS id, title, branch, worktree_path AS "worktreePath",
          workspace_path AS "workspacePath", updated_at AS "updatedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId} AND deleted_at IS NULL
      `,
    });
    // Index pages never hydrate message or plan bodies. Both branches use the
    // thread/creation indexes; the ID breaks ties when timestamps are identical.
    const listItems = SqlSchema.findAll({
      Request: ReadThreadHistoryInput,
      Result: ItemRow,
      execute: ({ threadId, after }) => sql`
        SELECT * FROM (
          SELECT 'message:' || message_id AS id, 'message' AS kind, role,
            created_at AS "createdAt", updated_at AS "updatedAt",
            is_streaming AS "isStreaming", length(CAST(text AS BLOB)) AS "byteLength",
            COALESCE(json_array_length(attachments_json), 0) AS "attachmentCount"
          FROM projection_thread_messages
          WHERE thread_id = ${threadId} AND role IN ('user', 'assistant')
            ${after === undefined ? sql`` : sql`AND created_at >= ${after.createdAt} AND (created_at > ${after.createdAt} OR 'message:' || message_id > ${after.itemId})`}
          UNION ALL
          SELECT 'plan:' || plan_id AS id, 'plan' AS kind, 'assistant' AS role,
            created_at AS "createdAt", updated_at AS "updatedAt",
            0 AS "isStreaming", length(CAST(plan_markdown AS BLOB)) AS "byteLength",
            0 AS "attachmentCount"
          FROM projection_thread_proposed_plans
          WHERE thread_id = ${threadId}
            ${after === undefined ? sql`` : sql`AND created_at >= ${after.createdAt} AND (created_at > ${after.createdAt} OR 'plan:' || plan_id > ${after.itemId})`}
        )
        ORDER BY "createdAt", id
        LIMIT ${PAGE_SIZE + 1}
      `,
    });
    const getItem = SqlSchema.findOneOption({
      Request: ReadThreadHistoryInput,
      Result: Schema.Struct({ ...ItemRow.fields, bytes: Schema.Uint8Array }),
      execute: ({ threadId, itemId = "", textOffset = 0 }) =>
        itemId.startsWith("plan:")
          ? sql`
              SELECT 'plan:' || plan_id AS id, 'plan' AS kind, 'assistant' AS role,
                created_at AS "createdAt", updated_at AS "updatedAt",
                0 AS "isStreaming", length(CAST(plan_markdown AS BLOB)) AS "byteLength",
                0 AS "attachmentCount",
                substr(CAST(plan_markdown AS BLOB), ${textOffset + 1}, ${TEXT_PAGE_SIZE}) AS bytes
              FROM projection_thread_proposed_plans
              WHERE thread_id = ${threadId} AND plan_id = ${itemId.slice(5)}
            `
          : sql`
              SELECT 'message:' || message_id AS id, 'message' AS kind, role,
                created_at AS "createdAt", updated_at AS "updatedAt",
                is_streaming AS "isStreaming", length(CAST(text AS BLOB)) AS "byteLength",
                COALESCE(json_array_length(attachments_json), 0) AS "attachmentCount",
                substr(CAST(text AS BLOB), ${textOffset + 1}, ${TEXT_PAGE_SIZE}) AS bytes
              FROM projection_thread_messages
              WHERE thread_id = ${threadId} AND message_id = ${itemId.slice(8)}
                AND role IN ('user', 'assistant')
            `,
    });

    return ThreadHistoryToolkit.of({
      read_thread_history: Effect.fn("ThreadHistory.read")(
        function* (input) {
          const scope = yield* McpInvocationContext;
          if (
            (input.itemId === undefined && input.textOffset !== undefined) ||
            (input.itemId !== undefined && input.after !== undefined)
          ) {
            return yield* new ThreadHistoryError({
              message: "Use after for index pages, or itemId with textOffset for item text.",
            });
          }
          const thread = yield* getThread(input.threadId);
          if (Option.isNone(thread)) {
            return yield* new ThreadHistoryError({
              message: "This thread was not found in this environment or has been deleted.",
            });
          }
          const base = { environmentId: scope.environmentId, thread: thread.value };
          if (input.itemId !== undefined) {
            if (!input.itemId.startsWith("message:") && !input.itemId.startsWith("plan:")) {
              return yield* new ThreadHistoryError({
                message: "Use an itemId returned by the index.",
              });
            }
            const row = yield* getItem(input);
            if (Option.isNone(row)) {
              return yield* new ThreadHistoryError({
                message: "This item was not found in this thread.",
              });
            }
            const { bytes, ...metadata } = row.value;
            // Streaming decode retains an incomplete trailing code point. Advance
            // only by returned bytes so the next read starts at that character.
            const text = yield* Effect.try({
              try: () =>
                new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes, {
                  stream: true,
                }),
              catch: () =>
                new ThreadHistoryError({
                  message:
                    "textOffset must be a UTF-8 character boundary. Use the returned nextTextOffset.",
                }),
            });
            const item = { ...metadata, isStreaming: metadata.isStreaming === 1, text };
            const next = (input.textOffset ?? 0) + Buffer.byteLength(text, "utf8");
            return {
              ...base,
              items: [],
              nextCursor: null,
              item,
              nextTextOffset: next < item.byteLength ? next : null,
            };
          }
          const rows = yield* listItems(input);
          const items = rows.slice(0, PAGE_SIZE).map((row) => ({
            ...row,
            isStreaming: row.isStreaming === 1,
          }));
          const last = items.at(-1);
          return {
            ...base,
            items,
            nextCursor:
              rows.length > PAGE_SIZE && last !== undefined
                ? { createdAt: last.createdAt, itemId: last.id }
                : null,
            item: null,
            nextTextOffset: null,
          };
        },
        sql.withTransaction,
        Effect.mapError((error) =>
          isThreadHistoryError(error)
            ? error
            : new ThreadHistoryError({ message: "Could not read this thread's saved history." }),
        ),
      ),
    });
  }),
);
