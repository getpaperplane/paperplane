import { assert, it } from "@effect/vitest";
import {
  CommandId,
  OrchestrationV2DomainEventJson,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@rove-code/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as IdAllocator from "@rove-code/provider-core/server/IdAllocator";

const encodeEvent = Schema.encodeSync(OrchestrationV2DomainEventJson);
const bytes = (event: OrchestrationV2DomainEvent) =>
  Buffer.byteLength(JSON.stringify(encodeEvent(event)));

it.effect(
  "bounds a six-level Pi/MCP delegation chain without changing native-provider derivation",
  () =>
    Effect.gen(function* () {
      const ids = yield* IdAllocator.IdAllocatorV2;
      const driver = ProviderDriverKind.make("pi");
      const providerInstanceId = ProviderInstanceId.make("pi");
      const now = DateTime.makeUnsafe("2026-08-01T00:00:00.000Z");
      // Model both binaries with the same native keys, UUID widths, event shapes and
      // per-thread Pi sessions. Legacy children represent a chain created before the
      // upgrade (current code correctly gives newly created children a v2 namespace).
      const measure = Effect.fnUntraced(function* (idDerivationVersion: 2 | undefined) {
        const namespace = { idDerivationVersion };
        let threadId = ThreadId.make("thread:00000000-0000-4000-8000-000000000000");
        const rows = [];
        for (let depth = 1; depth <= 6; depth++) {
          const providerSessionId = yield* ids.allocate.providerSession({
            threadId,
            providerInstanceId,
          });
          const commandId = CommandId.make(
            [
              "command",
              "mcp",
              encodeURIComponent(providerSessionId),
              "delegate-task",
              `call-depth-${depth}`,
            ].join(":"),
          );
          const input = { ...namespace, commandId };
          const runId = ids.derive.run({ ...namespace, threadId, ordinal: 1 });
          const attemptId = ids.derive.runAttempt({ ...namespace, runId, attemptOrdinal: 1 });
          const nodeId = ids.derive.delegatedTaskNode(input);
          const childThreadId = ids.derive.delegatedTaskThread(input);
          const itemId = ids.derive.delegatedTaskTurnItem(input);
          const providerThreadId = ids.derive.providerThread({
            driver,
            nativeThreadId: `/tmp/pi/sessions/2026-08-01T00-00-00Z_00000000-0000-4000-8000-00000000000${depth}.jsonl`,
          });
          // Matches PiAdapterV2.startTurn/baseItem, including the deliberately
          // unchanged provider turn and native item derivations.
          const providerTurnId = ids.derive.providerTurn({
            driver,
            nativeTurnId: `${providerThreadId}:${attemptId}`,
          });
          const nativeItemId = `${providerThreadId}:${providerTurnId}:call-depth-${depth}`;
          const nativeTurnItemId = ids.derive.turnItemFromProviderItem({ driver, nativeItemId });
          const base = {
            threadId,
            runId,
            nodeId,
            driver,
            providerInstanceId,
            occurredAt: now,
            type: "turn-item.updated" as const,
          };
          const itemBase = {
            threadId,
            runId,
            providerThreadId,
            providerTurnId,
            parentItemId: null,
            ordinal: 101,
            status: "running" as const,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
          };
          const delegatedEvent: OrchestrationV2DomainEvent = {
            ...base,
            id: yield* ids.allocate.event({ threadId, commandId }),
            payload: {
              ...itemBase,
              id: itemId,
              nodeId,
              nativeItemRef: null,
              title: "Inspect the next layer",
              type: "subagent",
              subagentId: nodeId,
              origin: "app_owned",
              driver,
              providerInstanceId,
              childThreadId,
              prompt: "Inspect the next layer and report findings.",
              result: null,
            },
          };
          const nativeNodeId = ids.derive.nodeFromProviderItem({ driver, nativeItemId });
          const nativeEvent: OrchestrationV2DomainEvent = {
            ...base,
            nodeId: nativeNodeId,
            id: yield* ids.allocate.event({ threadId, providerSessionId }),
            payload: {
              ...itemBase,
              id: nativeTurnItemId,
              nodeId: nativeNodeId,
              nativeItemRef: { driver, nativeId: nativeItemId, strength: "strong" },
              title: "Read implementation",
              type: "command_execution",
              input: "rg -n identity packages/provider-core/src",
            },
          };
          rows.push({
            depth,
            delegatedId: itemId.length,
            nativeId: nativeTurnItemId.length,
            delegatedEvent: bytes(delegatedEvent),
            nativeEvent: bytes(nativeEvent),
          });
          threadId = childThreadId;
        }
        return rows;
      });
      const legacy = yield* measure(undefined);
      const compact = yield* measure(2);
      const measurements = compact.map((row, index) => ({
        depth: row.depth,
        delegatedId: `${legacy[index]!.delegatedId} -> ${row.delegatedId}`,
        nativeId: `${legacy[index]!.nativeId} -> ${row.nativeId}`,
        delegatedEventBytes: `${legacy[index]!.delegatedEvent} -> ${row.delegatedEvent}`,
        nativeEventBytes: `${legacy[index]!.nativeEvent} -> ${row.nativeEvent}`,
      }));
      yield* Effect.logInfo("Pi/MCP fixture wire bytes (legacy -> scoped compact)", measurements);
      assert.equal(new Set(compact.map((row) => row.delegatedId)).size, 1);
      assert.equal(new Set(compact.map((row) => row.nativeId)).size, 1);
      assert.equal(new Set(compact.map((row) => row.delegatedEvent)).size, 2); // root thread is shorter than delegated thread ids
      assert.equal(new Set(compact.map((row) => row.nativeEvent)).size, 2);
      for (const [index, row] of compact.entries()) {
        assert.isAtMost(row.delegatedId, 72);
        assert.isBelow(row.delegatedEvent, legacy[index]!.delegatedEvent);
        assert.isBelow(row.nativeEvent, legacy[index]!.nativeEvent);
      }
    }).pipe(Effect.provide(IdAllocator.layer)),
);
