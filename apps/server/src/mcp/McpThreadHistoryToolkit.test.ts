import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@rove-code/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ThreadHistoryToolkitRegistrationLive } from "./McpHttpServer.ts";
import { McpInvocationContext, type McpCapability } from "./McpInvocationContext.ts";
import {
  ThreadHistoryResult,
  type ReadThreadHistoryInput,
} from "./toolkits/threadHistory/tools.ts";

const createdAt = "2026-10-15T00:00:00.000Z";
const updatedAt = "2026-10-15T01:00:00.000Z";
const encodeResult = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeResult = Schema.decodeUnknownEffect(ThreadHistoryResult);
const TestLayer = ThreadHistoryToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const call = Effect.fn("test.callThreadHistory")(function* (
  args: NonNullable<Parameters<McpServer.McpServer["Service"]["callTool"]>[0]["arguments"]>,
  provider = "pi",
) {
  const server = yield* McpServer.McpServer;
  return yield* server.callTool({ name: "read_thread_history", arguments: args }).pipe(
    Effect.provideService(McpInvocationContext, {
      environmentId: EnvironmentId.make("local"),
      threadId: ThreadId.make("caller"),
      providerSessionId: "caller-session",
      providerInstanceId: ProviderInstanceId.make(provider),
      capabilities: new Set<McpCapability>(),
      issuedAt: 1,
    }),
    Effect.provideService(McpSchema.McpServerClient, client),
  );
});
const read = Effect.fn("test.readThreadHistory")(function* (input: ReadThreadHistoryInput) {
  const result = yield* call(input);
  expect(result.isError).toBe(false);
  return yield* decodeResult(result.structuredContent);
});
const seedThreads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const id of ["caller", "source", "other", "deleted"]) {
    yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at) VALUES (${id}, NULL, ${id}, '{"instanceId":"pi","model":"fixture"}', 'approval-required', 'default', ${createdAt}, ${createdAt})`;
  }
  yield* sql`UPDATE projection_threads SET deleted_at = ${updatedAt} WHERE thread_id = 'deleted'`;
});
const addMessage = Effect.fn("test.addHistoryMessage")(function* (
  id: string,
  text: string,
  options: { threadId?: string; role?: string; streaming?: boolean } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at) VALUES (${id}, ${options.threadId ?? "source"}, NULL, ${options.role ?? "assistant"}, ${text}, ${options.streaming ? 1 : 0}, ${createdAt}, ${createdAt})`;
});
const source = ThreadId.make("source");

it.effect(
  "reads local conversation and plans without an imported handoff or source provider session",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seedThreads;
        const sql = yield* SqlClient.SqlClient;
        yield* addMessage("question", "Keep the original design decision.", { role: "user" });
        yield* addMessage("response", "The implementation is in the current worktree.");
        yield* addMessage("hidden", "Native/system material must not be returned.", {
          role: "system",
        });
        yield* sql`INSERT INTO projection_thread_proposed_plans (plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at) VALUES ('plan', 'source', NULL, '# Remaining work', ${createdAt}, ${createdAt})`;
        yield* sql`UPDATE projection_threads SET branch = 'feature/local', worktree_path = '/tmp/source-worktree' WHERE thread_id = 'source'`;
        const index = yield* read({ threadId: source });
        expect(index).toMatchObject({
          environmentId: "local",
          thread: { id: "source", branch: "feature/local", worktreePath: "/tmp/source-worktree" },
          items: [
            { id: "message:question", role: "user", kind: "message" },
            { id: "message:response", role: "assistant", kind: "message" },
            { id: "plan:plan", role: "assistant", kind: "plan" },
          ],
          nextCursor: null,
          item: null,
        });
        expect(index.items.every((item) => !("text" in item))).toBe(true);
        expect((yield* read({ threadId: source, itemId: "message:question" })).item?.text).toBe(
          "Keep the original design decision.",
        );
        expect((yield* read({ threadId: source, itemId: "plan:plan" })).item?.text).toBe(
          "# Remaining work",
        );
        expect(yield* sql`SELECT * FROM projection_thread_sessions`).toEqual([]);
        expect(yield* sql`SELECT * FROM projection_thread_activities`).toEqual([]);
      }),
    ).pipe(Effect.provide(TestLayer)),
);

it.effect("paginates tied timestamps without losing items as new messages arrive", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seedThreads;
      for (let index = 0; index < 12; index++) {
        yield* addMessage(String(index).padStart(2, "0"), `Message ${index}`);
      }
      const first = yield* read({ threadId: source });
      expect(first.items.map((item) => item.id)).toEqual(
        Array.from({ length: 10 }, (_, index) => `message:${String(index).padStart(2, "0")}`),
      );
      expect(first.nextCursor).toEqual({ createdAt, itemId: "message:09" });
      // An older insertion must not shift the cursor and duplicate a previous item.
      yield* addMessage("00-before-cursor", "An earlier item arrived.");
      yield* addMessage("12", "A new item arrived.");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_thread_messages SET created_at = ${updatedAt} WHERE message_id = '12'`;
      yield* sql`INSERT INTO projection_thread_proposed_plans (plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at) VALUES ('09', 'source', NULL, '# Same timestamp, distinct item kind', ${createdAt}, ${createdAt})`;
      const second = yield* read({ threadId: source, after: first.nextCursor! });
      expect(second.items.map((item) => item.id)).toEqual([
        "message:10",
        "message:11",
        "plan:09",
        "message:12",
      ]);
      expect(second.nextCursor).toBeNull();
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("recovers long Unicode text in bounded pages for messages and plans", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seedThreads;
      const sql = yield* SqlClient.SqlClient;
      const text = "a".repeat(7_999) + "🧭\uFEFF\0Done";
      yield* addMessage("long", text);
      yield* sql`INSERT INTO projection_thread_proposed_plans (plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at) VALUES ('long', 'source', NULL, ${text}, ${createdAt}, ${createdAt})`;
      for (const itemId of ["message:long", "plan:long"]) {
        const first = yield* read({ threadId: source, itemId });
        expect(first.item).toMatchObject({ text: "a".repeat(7_999), byteLength: 8_011 });
        expect(first.nextTextOffset).toBe(7_999);
        const rest = yield* read({ threadId: source, itemId, textOffset: first.nextTextOffset! });
        expect(rest.item?.text).toBe("🧭\uFEFF\0Done");
        expect(first.item!.text + rest.item!.text).toBe(text);
        expect(rest.nextTextOffset).toBeNull();
        const end = yield* read({ threadId: source, itemId, textOffset: 9_000 });
        expect(end.item?.text).toBe("");
        expect(end.nextTextOffset).toBeNull();
      }
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("preserves leading BOMs and nulls, and rejects offsets inside a UTF-8 character", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seedThreads;
      yield* addMessage("special", "\uFEFFalpha\0beta🧭");
      const result = yield* read({ threadId: source, itemId: "message:special" });
      expect(result.item).toMatchObject({ text: "\uFEFFalpha\0beta🧭", byteLength: 17 });
      const invalid = yield* call({ threadId: source, itemId: "message:special", textOffset: 1 });
      expect(invalid.isError).toBe(true);
      expect(invalid.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining("UTF-8 character boundary") }),
      ]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "labels live streaming content and rereads completed updates without changing the source",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seedThreads;
        const sql = yield* SqlClient.SqlClient;
        yield* addMessage("live", "Working", { streaming: true });
        expect((yield* read({ threadId: source })).items[0]?.isStreaming).toBe(true);
        expect((yield* read({ threadId: source, itemId: "message:live" })).item?.text).toBe(
          "Working",
        );
        yield* sql`UPDATE projection_thread_messages SET text = 'Finished with the latest decision.', is_streaming = 0, updated_at = ${updatedAt} WHERE message_id = 'live'`;
        expect((yield* read({ threadId: source, itemId: "message:live" })).item).toMatchObject({
          text: "Finished with the latest decision.",
          isStreaming: false,
          updatedAt,
        });
        expect(
          yield* sql`SELECT text, is_streaming FROM projection_thread_messages WHERE message_id = 'live'`,
        ).toEqual([{ text: "Finished with the latest decision.", is_streaming: 0 }]);
      }),
    ).pipe(Effect.provide(TestLayer)),
);

it.effect("reads empty and archived threads but rejects missing or deleted threads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seedThreads;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_threads SET archived_at = ${updatedAt} WHERE thread_id = 'source'`;
      expect((yield* read({ threadId: source })).items).toEqual([]);
      for (const id of ["missing", "deleted"]) {
        const result = yield* call({ threadId: id });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([
          expect.objectContaining({
            text: expect.stringContaining("not found in this environment"),
          }),
        ]);
      }
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("does not read another thread's item or system-only messages", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seedThreads;
      const sql = yield* SqlClient.SqlClient;
      yield* addMessage("foreign", "Do not leak this text.", { threadId: "other" });
      yield* addMessage("hidden", "System-only text.", { role: "system" });
      yield* sql`INSERT INTO projection_thread_proposed_plans (plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at) VALUES ('foreign', 'other', NULL, 'Other plan', ${createdAt}, ${createdAt})`;
      for (const itemId of ["message:foreign", "plan:foreign", "message:hidden", "missing"]) {
        const result = yield* call({ threadId: source, itemId });
        expect(result.isError).toBe(true);
        expect(encodeResult(result)).not.toContain("Do not leak");
        expect(encodeResult(result)).not.toContain("System-only");
      }
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("rejects inconsistent paging arguments", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seedThreads;
      for (const args of [
        { threadId: source, textOffset: -1, itemId: "message:missing" },
        { threadId: source, textOffset: 1 },
        {
          threadId: source,
          itemId: "message:missing",
          after: { createdAt, itemId: "message:previous" },
        },
      ]) {
        const result = yield* call(args).pipe(Effect.result);
        expect(
          result._tag === "Failure" || result.success.isError === true,
          encodeResult(args),
        ).toBe(true);
      }
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("exposes the same read-only tool to every provider without browser capabilities", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seedThreads;
      const server = yield* McpServer.McpServer;
      expect(
        server.tools.find(({ tool }) => tool.name === "read_thread_history")?.tool.annotations
          ?.readOnlyHint,
      ).toBe(true);
      for (const provider of [
        "codex",
        "claude",
        "cursor",
        "grok",
        "opencode",
        "antigravity",
        "pi",
      ]) {
        expect((yield* call({ threadId: source }, provider)).isError).toBe(false);
      }
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("returns a bounded error instead of exposing database failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE projection_threads`;
      const result = yield* call({ threadId: source });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({
          text: expect.stringContaining("Could not read this thread's saved history."),
        }),
      ]);
      expect(encodeResult(result)).not.toContain("no such table");
    }),
  ).pipe(Effect.provide(TestLayer)),
);
