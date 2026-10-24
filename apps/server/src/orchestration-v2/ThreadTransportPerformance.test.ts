import {
  EventId,
  MessageId,
  OrchestrationV2RpcSchemas,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
} from "@getpaperplane/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import { describe, expect, it } from "vite-plus/test";

import { buildBoundedThreadStreamSnapshot } from "./ThreadStream.ts";
import { buildBoundedThreadProjection } from "./threadHistoryPaging.ts";
import { makeThreadLiveTextProjector, projectDomainEventForWire } from "./WireProjection.ts";

const SNAPSHOT_SEQUENCE = 600;
const ROW_COUNT = 600;
const OUTPUT_BYTES_PER_ROW = 8_192;
const NOW = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const THREAD_ID = ThreadId.make("thread-perf");
const PROVIDER_INSTANCE_ID = ProviderInstanceId.make("codex");

// Recorded before bounded WebSocket fallback at 91b193653ec. Keep this number
// here so later transport changes retain a direct, reproducible comparison.
const HISTORICAL_FULL_SNAPSHOT_APPLICATION_BYTES = 10_375_079;
// Contract encoding plus the Effect RPC Chunk envelope adds 42 bytes to both
// snapshot variants. WebSocket framing and compression are intentionally out
// of scope for this deterministic pre-compression measurement.
const FULL_SNAPSHOT_RPC_JSON_BYTES = 10_375_121;
const PRE_OMISSION_BOUNDED_SNAPSHOT_RPC_JSON_BYTES = 1_038_647;
// The first payload-omitting projection measured 67,412 bytes.
const MAX_PROJECTED_BOUNDED_SNAPSHOT_RPC_JSON_BYTES = 131_072;
const PRE_OMISSION_COMMAND_EVENT_RPC_JSON_BYTES = 8_790;
// The first payload-omitting projection measured 586 bytes.
const MAX_PROJECTED_COMMAND_EVENT_RPC_JSON_BYTES = 1_024;

const encodeThreadStreamItem = Schema.encodeSync(
  Schema.toCodecJson(OrchestrationV2RpcSchemas.subscribeThread.output),
);

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function encodedThreadStreamChunkBytes(value: OrchestrationV2ThreadStreamItem): number {
  const response = {
    _tag: "Chunk",
    requestId: 0,
    values: [encodeThreadStreamItem(value)],
  } satisfies RpcMessage.ResponseChunkEncoded;
  return encodedBytes(response);
}

function makeCommandItem(index: number) {
  return {
    id: TurnItemId.make(`item-${index}`),
    type: "command_execution",
    threadId: THREAD_ID,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: index + 1,
    status: "completed",
    title: `Command ${index}`,
    input: `cmd-${index}`,
    output: "x".repeat(OUTPUT_BYTES_PER_ROW),
    exitCode: 0,
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
  } satisfies OrchestrationV2TurnItem;
}

function makeProjection(): OrchestrationV2ThreadProjection {
  const visibleTurnItems: OrchestrationV2ProjectedTurnItem[] = Array.from(
    { length: ROW_COUNT },
    (_, index) => {
      const item = makeCommandItem(index);
      return {
        position: index,
        visibility: "local",
        sourceThreadId: THREAD_ID,
        sourceItemId: item.id,
        item,
      };
    },
  );

  return {
    thread: {
      id: THREAD_ID,
      projectId: ProjectId.make("project-perf"),
      title: "Thread",
      providerInstanceId: PROVIDER_INSTANCE_ID,
      modelSelection: { instanceId: PROVIDER_INSTANCE_ID, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: THREAD_ID,
      },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: visibleTurnItems.map((row) => row.item),
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems,
    updatedAt: NOW,
  };
}

function makeTurnItemEvent(item: OrchestrationV2TurnItem): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event-${item.id}`),
    type: "turn-item.updated",
    threadId: THREAD_ID,
    occurredAt: NOW,
    payload: item,
  };
}

describe("thread transport payload budget", () => {
  it.each(["message", "assistant_message", "reasoning"] as const)(
    "streams a 20 KiB %s reply with append-sized frames at 50 ms flushes",
    (entityType) => {
      // 20 characters per 50 ms flush: 400 characters/sec for 51.2 seconds.
      const reply = "x".repeat(20 * 1024);
      const project = makeThreadLiveTextProjector(true);
      const {
        type: _type,
        input: _input,
        output: _output,
        exitCode: _exitCode,
        ...common
      } = makeCommandItem(0);
      let before = 0;
      let after = 0;
      let appends = 0;
      for (let frame = 1; frame <= 1025; frame++) {
        const terminal = frame === 1025;
        const text = reply.slice(0, Math.min(frame * 20, reply.length));
        const updatedAt = DateTime.add(NOW, { milliseconds: frame * 50 });
        const messageId = MessageId.make("reply-message");
        const event: OrchestrationV2DomainEvent =
          entityType === "message"
            ? {
                id: EventId.make(`reply-${frame}`),
                type: "message.updated",
                threadId: THREAD_ID,
                occurredAt: updatedAt,
                payload: {
                  id: messageId,
                  threadId: THREAD_ID,
                  runId: null,
                  nodeId: null,
                  role: "assistant",
                  text,
                  attachments: [],
                  streaming: !terminal,
                  createdBy: "agent",
                  creationSource: "provider",
                  createdAt: NOW,
                  updatedAt,
                },
              }
            : makeTurnItemEvent({
                ...common,
                type: entityType,
                ...(entityType === "assistant_message" ? { messageId } : {}),
                status: terminal ? "completed" : "running",
                completedAt: terminal ? updatedAt : null,
                text,
                streaming: !terminal,
                updatedAt,
              } as OrchestrationV2TurnItem);
        const full = { kind: "event" as const, sequence: frame, event };
        const compact = project(full);
        before += encodedThreadStreamChunkBytes(full);
        after += encodedThreadStreamChunkBytes(compact);
        if (compact.kind === "text-append") appends++;
        if (frame === 1 || terminal) expect(compact).toBe(full);
      }
      expect(appends).toBe(1023);
      expect(after).toBeLessThan(400_000);
      expect(after / before).toBeLessThan(0.04);
      Effect.runSync(
        Effect.logInfo(
          `20KiB ${entityType}: full=${before} append=${after} bytes (${(100 * (1 - after / before)).toFixed(2)}% less)`,
        ),
      );
    },
  );
  it("records full, bounded, and payload-omitting snapshot improvements", () => {
    const projection = makeProjection();
    const historicalFullSnapshot: OrchestrationV2ThreadStreamItem = {
      kind: "snapshot",
      snapshotSequence: SNAPSHOT_SEQUENCE,
      projection,
    };
    const preOmissionBounded = buildBoundedThreadProjection({
      projection,
      snapshotSequence: SNAPSHOT_SEQUENCE,
    });
    const preOmissionBoundedSnapshot: OrchestrationV2ThreadStreamItem = {
      kind: "snapshot",
      snapshotSequence: SNAPSHOT_SEQUENCE,
      projection: preOmissionBounded.projection,
      historyCursor: preOmissionBounded.historyCursor,
      hasMoreHistory: preOmissionBounded.hasMoreHistory,
      latestLocalTurnOrdinal: preOmissionBounded.latestLocalTurnOrdinal,
      payloadBudgetExceeded: preOmissionBounded.payloadBudgetExceeded,
    };
    const projectedBoundedSnapshot = buildBoundedThreadStreamSnapshot({
      projection,
      snapshotSequence: SNAPSHOT_SEQUENCE,
    });

    const historicalApplicationBytes = encodedBytes(historicalFullSnapshot);
    const fullRpcJsonBytes = encodedThreadStreamChunkBytes(historicalFullSnapshot);
    const preOmissionBoundedRpcJsonBytes = encodedThreadStreamChunkBytes(
      preOmissionBoundedSnapshot,
    );
    const projectedBoundedRpcJsonBytes = encodedThreadStreamChunkBytes(projectedBoundedSnapshot);

    expect(historicalApplicationBytes).toBe(HISTORICAL_FULL_SNAPSHOT_APPLICATION_BYTES);
    expect(fullRpcJsonBytes).toBe(FULL_SNAPSHOT_RPC_JSON_BYTES);
    expect(preOmissionBoundedRpcJsonBytes).toBe(PRE_OMISSION_BOUNDED_SNAPSHOT_RPC_JSON_BYTES);
    expect(projectedBoundedRpcJsonBytes).toBeLessThanOrEqual(
      MAX_PROJECTED_BOUNDED_SNAPSHOT_RPC_JSON_BYTES,
    );
    expect(projectedBoundedRpcJsonBytes / fullRpcJsonBytes).toBeLessThanOrEqual(0.02);
    expect(preOmissionBoundedSnapshot.projection.visibleTurnItems).toHaveLength(60);
    expect(projectedBoundedSnapshot.projection.visibleTurnItems).toHaveLength(75);
    expect(projectedBoundedSnapshot.hasMoreHistory).toBe(true);
    expect(projectedBoundedSnapshot.payloadBudgetExceeded).toBe(false);
  });

  it("omits command output from a live event without changing persisted source data", () => {
    const sourceItem = makeCommandItem(0);
    const sourceEvent = makeTurnItemEvent(sourceItem);
    const projectedEvent = projectDomainEventForWire(sourceEvent);
    const preOmissionStreamItem: OrchestrationV2ThreadStreamItem = {
      kind: "event",
      sequence: 1,
      event: sourceEvent,
    };
    const projectedStreamItem: OrchestrationV2ThreadStreamItem = {
      kind: "event",
      sequence: 1,
      event: projectedEvent,
    };

    const preOmissionRpcJsonBytes = encodedThreadStreamChunkBytes(preOmissionStreamItem);
    const projectedRpcJsonBytes = encodedThreadStreamChunkBytes(projectedStreamItem);

    expect(preOmissionRpcJsonBytes).toBe(PRE_OMISSION_COMMAND_EVENT_RPC_JSON_BYTES);
    expect(projectedRpcJsonBytes).toBeLessThanOrEqual(MAX_PROJECTED_COMMAND_EVENT_RPC_JSON_BYTES);
    expect(projectedRpcJsonBytes / preOmissionRpcJsonBytes).toBeLessThanOrEqual(0.1);
    expect(sourceItem).toHaveProperty("output", "x".repeat(OUTPUT_BYTES_PER_ROW));
    expect(projectedEvent.payload).not.toHaveProperty("output");
  });

  it("omits ordinary dynamic tool output even when it is small", () => {
    const sourceItem: OrchestrationV2TurnItem = {
      id: TurnItemId.make("item-dynamic"),
      type: "dynamic_tool",
      threadId: THREAD_ID,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: "Dynamic tool",
      toolName: "lookup",
      input: { query: "status" },
      output: { content: "small raw result" },
      startedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
    };
    const projectedEvent = projectDomainEventForWire(makeTurnItemEvent(sourceItem));

    expect(sourceItem).toHaveProperty("output", { content: "small raw result" });
    expect(projectedEvent.payload).not.toHaveProperty("output");
  });
});
