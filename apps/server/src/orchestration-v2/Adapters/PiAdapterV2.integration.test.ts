// @effect-diagnostics nodeBuiltinImport:off - Copies a deterministic SDK model fixture into an isolated agent directory.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { it, assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@getpaperplane/contracts";
import * as TestProviderHost from "@getpaperplane/provider-testing/TestProviderHost";
import { checkpointWorkspace } from "@getpaperplane/provider-testing/replayWorkspace";
import * as IdAllocator from "@getpaperplane/provider-core/server/IdAllocator";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import { layerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { PiDriver } from "../../provider/Drivers/PiDriver.ts";
import * as PiExtensionStatuses from "../../provider/PiExtensionStatuses.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

it.effect(
  "runs the bundled SDK worker through real V2 persistence/checkpointing, rollback, and worker crash recovery",
  () =>
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("pi-sdk-v2");
      const fs = yield* FileSystem.FileSystem;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "paperplane-pi-v2-agent-" });
      const fixture = NodePath.join(agentDir, "fixture.ts");
      NodeFS.copyFileSync(
        new URL("../../provider/Layers/fixtures/pi-instance-extension.ts", import.meta.url),
        fixture,
      );
      NodeFS.writeFileSync(
        NodePath.join(agentDir, "settings.json"),
        JSON.stringify({ extensions: [fixture] }),
      );
      const instanceId = ProviderInstanceId.make("pi");
      const selection = { instanceId, model: "instance-fixture/fixture" };
      const registry = Layer.effect(
        ProviderAdapterRegistry.ProviderAdapterRegistryV2,
        Effect.gen(function* () {
          const instance = yield* PiDriver.create({
            instanceId,
            displayName: undefined,
            enabled: true,
            environment: [{ name: "PI_OFFLINE", value: "1", sensitive: false }],
            config: {
              ...PiDriver.defaultConfig(),
              agentDir,
              workloadProtection: "off",
            },
          });
          const capabilities = yield* instance.orchestrationAdapter.getCapabilities();
          assert.isFalse(capabilities.subagents.supportsSubagents);
          assert.isFalse(capabilities.subagents.emitsSubagentLifecycle);
          assert.isFalse(capabilities.subagents.canWaitForSubagents);
          return ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
            get: () => Effect.succeed(instance.orchestrationAdapter),
            list: () => Effect.succeed([instanceId]),
            getMetadata: () =>
              Effect.gen(function* () {
                return {
                  driver: instance.driverKind,
                  continuationKey: instance.continuationIdentity.continuationKey,
                  enabled: true,
                  capabilities: yield* instance.orchestrationAdapter.getCapabilities(),
                };
              }).pipe(Effect.orDie),
          });
        }),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerConfig.layerTest(cwd, { prefix: "paperplane-pi-v2-driver-" }),
            ServerSettingsService.layerTest(),
            TestProviderHost.layer({ cwd, runBackgroundWork: false }),
            IdAllocator.layer,
            PiExtensionStatuses.layer,
          ).pipe(Layer.provideMerge(NodeServices.layer)),
        ),
      );
      const runtime = layerWithRegistry(
        { name: "pi-sdk-worker", runtimePolicyOverride: { cwd } },
        registry,
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("sdk-thread");
        const terminal = yield* Deferred.make<void>();
        const secondTerminal = yield* Deferred.make<void>();
        const crashTerminal = yield* Deferred.make<void>();
        const recoveryTerminal = yield* Deferred.make<void>();
        const terminals = [terminal, secondTerminal, crashTerminal, recoveryTerminal];
        yield* orchestrator.streamStoredEvents.pipe(
          Stream.runForEach(({ event }) =>
            event.type === "run.updated" &&
            event.threadId === threadId &&
            ["completed", "failed", "interrupted"].includes(event.payload.status)
              ? Deferred.succeed(terminals[event.payload.ordinal - 1]!, undefined)
              : Effect.void,
          ),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("sdk-create"),
          threadId,
          projectId: ProjectId.make("sdk-project"),
          title: "SDK integration",
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("sdk-message"),
          messageId: MessageId.make("sdk-user"),
          threadId,
          text: "workload-hello",
          attachments: [],
          modelSelection: selection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* Deferred.await(terminal);
        yield* worker.drain();
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(projection.runs, 1);
        assert.strictEqual(projection.runs[0]?.status, "completed");
        assert.isTrue(
          projection.messages.some(
            (message) =>
              message.role === "assistant" && message.text === NodePath.basename(agentDir),
          ),
        );
        assert.lengthOf(projection.subagents, 0);
        assert.isNotNull(projection.runs[0]?.checkpointId);
        assert.isTrue(projection.providerThreads[0]?.nativeThreadRef?.nativeId?.endsWith(".jsonl"));
        // Release through the production session lifecycle, then resume the same native file.
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        yield* manager.close(projection.providerSessions[0]!.id);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("sdk-second"),
          messageId: MessageId.make("sdk-second-user"),
          threadId,
          text: "workload-hello",
          attachments: [],
          modelSelection: selection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* Deferred.await(secondTerminal);
        yield* worker.drain();
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(resumed.runs, 2);
        assert.strictEqual(resumed.runs[1]?.status, "completed");
        assert.strictEqual(
          resumed.providerThreads[0]?.nativeThreadRef?.nativeId,
          projection.providerThreads[0]?.nativeThreadRef?.nativeId,
        );
        assert.lengthOf(resumed.subagents, 0);
        const checkpoint = resumed.checkpoints.find(
          (checkpoint) => checkpoint.id === projection.runs[0]?.checkpointId,
        )!;
        const rollbackDone = yield* Deferred.make<void>();
        yield* orchestrator.streamStoredEvents.pipe(
          Stream.runForEach(({ event }) =>
            (event.type === "run.updated" &&
              event.threadId === threadId &&
              event.payload.status === "rolled_back") ||
            (event.type === "thread.metadata-updated" &&
              event.threadId === threadId &&
              event.payload.rollbackFailure != null)
              ? Deferred.succeed(rollbackDone, undefined)
              : Effect.void,
          ),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* orchestrator.dispatch({
          type: "checkpoint.rollback",
          restoreFiles: false,
          commandId: CommandId.make("sdk-rollback"),
          threadId,
          scopeId: checkpoint.scopeId,
          checkpointId: checkpoint.id,
        });
        yield* Deferred.await(rollbackDone);
        yield* worker.drain();
        const rolledBack = yield* orchestrator.getThreadProjection(threadId);
        assert.isTrue(
          rolledBack.runs.some((run) => run.ordinal === 2 && run.status === "rolled_back"),
          JSON.stringify({
            runs: rolledBack.runs.map((run) => ({ ordinal: run.ordinal, status: run.status })),
            failure: rolledBack.thread.rollbackFailure,
            turns: rolledBack.providerTurns.map((turn) => ({
              ordinal: turn.ordinal,
              native: turn.nativeTurnRef,
            })),
          }),
        );
        assert.isNull(rolledBack.thread.rollbackFailure);
        for (const [ordinal, text] of [
          [3, "/exit-instance"],
          [4, "hello"],
        ] as const) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`sdk-${ordinal}`),
            messageId: MessageId.make(`sdk-user-${ordinal}`),
            threadId,
            text,
            attachments: [],
            modelSelection: selection,
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* Deferred.await(terminals[ordinal - 1]!);
          yield* worker.drain();
          const after = yield* orchestrator.getThreadProjection(threadId);
          assert.strictEqual(
            after.runs.find((run) => run.ordinal === ordinal)?.status,
            ordinal === 3 ? "failed" : "completed",
          );
          assert.strictEqual(after.providerThreads[0]?.id, projection.providerThreads[0]?.id);
          assert.strictEqual(
            after.providerThreads[0]?.nativeThreadRef?.nativeId,
            projection.providerThreads[0]?.nativeThreadRef?.nativeId,
          );
          assert.strictEqual(after.providerThreads[0]?.status, ordinal === 3 ? "error" : "idle");
          assert.strictEqual(
            after.providerSessions.at(-1)?.status,
            ordinal === 3 ? "error" : "ready",
          );
        }
      }).pipe(Effect.provide(runtime));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
