import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ImportedThreadHandoff,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type ThreadHandoff,
} from "@rove-code/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { HandoffToolkitRegistrationLive } from "./McpHttpServer.ts";
import { McpInvocationContext, type McpCapability } from "./McpInvocationContext.ts";
import type { ReadThreadHandoffInput } from "./toolkits/handoff/tools.ts";

const encodeImported = Schema.encodeEffect(Schema.fromJsonString(ImportedThreadHandoff));
const TestLayer = HandoffToolkitRegistrationLive.pipe(
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
const handoff: ThreadHandoff = {
  version: 1,
  transferId: "saved-transfer",
  sourceEnvironmentId: EnvironmentId.make("offline-source"),
  sourceThreadId: ThreadId.make("original"),
  sourceLabel: "Laptop",
  title: "Task",
  repositoryKey: "github.com/acme/repo",
  branch: "feature",
  commitSha: "a".repeat(40),
  sourceTurnId: null,
  sourceSequence: 1,
  createdAt: "2026-10-11T00:00:00.000Z",
  items: [{ id: "long", role: "assistant", kind: "message", text: "x".repeat(12_000) }],
  omittedItems: 2,
  omittedAttachments: 1,
};

it.effect(
  "reads destination-local history in bounded pages and refuses another thread's artifact",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const server = yield* McpServer.McpServer;
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at) VALUES ('destination', NULL, 'Destination', '{"instanceId":"codex","model":"fixture"}', 'approval-required', 'default', ${handoff.createdAt}, ${handoff.createdAt})`;
        const payload = yield* encodeImported({ handoff, messageId: MessageId.make("first") });
        yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at) VALUES ('import', 'destination', NULL, 'info', 'thread.handoff', 'Imported context', ${payload}, 1, ${handoff.createdAt})`;
        const call = (threadId: string, args: ReadThreadHandoffInput) =>
          server.callTool({ name: "read_thread_handoff", arguments: args }).pipe(
            Effect.provideService(McpInvocationContext, {
              environmentId: EnvironmentId.make("destination"),
              threadId: ThreadId.make(threadId),
              providerSessionId: "fixture",
              providerInstanceId: ProviderInstanceId.make("codex"),
              capabilities: new Set<McpCapability>(),
              issuedAt: 1,
            }),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        const index = yield* call("destination", {});
        expect(index.isError).toBe(false);
        expect(index.structuredContent).toMatchObject({
          items: [{ id: "long", textLength: 12_000 }],
          omittedItems: 2,
          omittedAttachments: 1,
        });
        const first = yield* call("destination", { itemId: "long" });
        expect(first.structuredContent).toMatchObject({
          item: { text: "x".repeat(8_000) },
          nextTextOffset: 8_000,
        });
        const rest = yield* call("destination", { itemId: "long", textOffset: 8_000 });
        expect(rest.structuredContent).toMatchObject({
          item: { text: "x".repeat(4_000) },
          nextTextOffset: null,
        });
        expect((yield* call("unrelated", { transferId: handoff.transferId })).isError).toBe(true);
        expect((yield* call("destination", { transferId: "not-this-transfer" })).isError).toBe(
          true,
        );
      }),
    ).pipe(Effect.provide(TestLayer)),
);
