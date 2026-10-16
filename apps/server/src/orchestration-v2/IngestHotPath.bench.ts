import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  TurnItemId,
} from "@rove-code/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { describe, it } from "vite-plus/test";
import * as IdAllocator from "@rove-code/provider-core/server/IdAllocator";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { makeAssistantStreamingFilter } from "./assistantStreaming.ts";

const database = Sqlite.layerMemory;
const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(Layer.provide(database));
const sink = EventSink.layer.pipe(Layer.provide(Layer.merge(stores, database)));
// No benchmark event touches Git; only its service acquisition happens during setup.
const git = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ingest-bench-" })),
  Layer.provide(NodeServices.layer),
);
const dependencies = Layer.mergeAll(
  stores,
  sink,
  IdAllocator.layer,
  ThreadCommandExecutor.layer,
  git,
);
const testLayer = Layer.merge(
  dependencies,
  ProviderEventIngestor.layer.pipe(Layer.provide(dependencies)),
);
const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const threadId = ThreadId.make("thread:ingest-bench");
const nodeId = NodeId.make("node:ingest-bench");
const messageId = MessageId.make("message:ingest-bench");
const start = DateTime.makeUnsafe("2026-10-01T00:00:00Z");
const node: OrchestrationV2ExecutionNode = {
  id: nodeId,
  threadId,
  runId: null,
  parentNodeId: null,
  rootNodeId: nodeId,
  kind: "assistant_message",
  status: "running",
  countsForRun: false,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  runtimeRequestId: null,
  checkpointScopeId: null,
  startedAt: start,
  completedAt: null,
};
const item = (text: string, updatedAt = start): OrchestrationV2TurnItem => ({
  id: TurnItemId.make("item:ingest-bench"),
  threadId,
  runId: null,
  nodeId,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "running",
  title: null,
  startedAt: start,
  completedAt: null,
  updatedAt,
  type: "assistant_message",
  messageId,
  text,
  streaming: true,
});
const message = (text: string, updatedAt = start) => ({
  id: messageId,
  threadId,
  runId: null,
  nodeId,
  createdBy: "agent" as const,
  creationSource: "provider" as const,
  role: "assistant" as const,
  text,
  attachments: [],
  createdAt: start,
  updatedAt,
  streaming: true,
});
const seed: OrchestrationV2DomainEvent = {
  id: EventId.make("event:ingest-bench:thread"),
  type: "thread.created",
  threadId,
  occurredAt: start,
  payload: {
    id: threadId,
    projectId: ProjectId.make("project:ingest-bench"),
    title: "Ingest benchmark",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: start,
    updatedAt: start,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
};
const options = { warmupTime: 500, time: 1_500 };

// Each sample reuses one in-memory database (setup/migrations are not timed).
// Logical 50 ms timestamps model adapter flushes without sleeping: timings are
// CPU/ingest work, not the intentional ten seconds spent waiting for 200 ticks.
describe("ingest hot path", () => {
  for (const type of ["turn-item.updated", "message.updated"] as const) {
    for (const kib of [4, 32, 64]) {
      it(`${type} ${kib} KiB (ops/s)`, async ({ bench }) => {
        const runtime = ManagedRuntime.make(testLayer);
        try {
          const eventSink = await runtime.runPromise(EventSink.EventSinkV2);
          await runtime.runPromise(eventSink.write({ events: [seed] }));
          const text = "x".repeat(kib * 1_024);
          let sequence = 0;
          await bench("write", () => {
            const common = {
              id: EventId.make(`event:ingest-bench:${++sequence}`),
              threadId,
              occurredAt: start,
            };
            const event: OrchestrationV2DomainEvent =
              type === "message.updated"
                ? { ...common, type, payload: message(text) }
                : { ...common, type, payload: item(text) };
            return runtime.runPromise(eventSink.write({ events: [event] }));
          }).run(options);
        } finally {
          await runtime.dispose();
        }
      });
    }
  }

  it("provider ingest: 200 growing assistant flushes at 50 ms (total ms)", async ({ bench }) => {
    const runtime = ManagedRuntime.make(testLayer);
    try {
      const eventSink = await runtime.runPromise(EventSink.EventSinkV2);
      const ingestor = await runtime.runPromise(ProviderEventIngestor.ProviderEventIngestorV2);
      await runtime.runPromise(eventSink.write({ events: [seed] }));
      const flushes = Array.from({ length: 200 }, (_, index) => {
        const at = DateTime.makeUnsafe(DateTime.toEpochMillis(start) + index * 50);
        return item("x".repeat((index + 1) * 256), at);
      });
      const ingest = {
        providerSessionId: ProviderSessionId.make("session:ingest-bench"),
        providerInstanceId: instanceId,
        threadId,
      };
      await bench("200 flushes", () =>
        runtime.runPromise(
          Effect.gen(function* () {
            for (const turnItem of flushes) {
              yield* ingestor.ingestNormalized({
                ...ingest,
                event: { type: "node.updated", driver, node },
              });
              yield* ingestor.ingestNormalized({
                ...ingest,
                event: { type: "turn_item.updated", driver, turnItem },
              });
              yield* ingestor.ingestNormalized({
                ...ingest,
                event: {
                  type: "message.updated",
                  driver,
                  message: message(
                    turnItem.type === "assistant_message" ? turnItem.text : "",
                    turnItem.updatedAt,
                  ),
                },
              });
            }
          }),
        )).run(options);
    } finally {
      await runtime.dispose();
    }
  });

  it("streaming filter: 50 KiB in an open fence at 50 ms (total ms)", async ({ bench }) => {
    const text = "```ts\n" + "const x = 1;\n".repeat(4_000);
    const flushes = Array.from({ length: 200 }, (_, index) => ({
      type: "turn_item.updated" as const,
      driver,
      turnItem: item(text.slice(0, Math.min(50 * 1_024, (index + 1) * 256))),
    }));
    await bench("200 flushes", () => {
      const filter = makeAssistantStreamingFilter("paragraph");
      for (const [index, event] of flushes.entries()) filter(event, index * 50);
    }).run(options);
  });
});
