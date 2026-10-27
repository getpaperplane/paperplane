// Adapted from pingdotgg/t3code#21322; exercise the real stdio process and
// persistence path, not a mocked session-failure event.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings, CommandId, MessageId, ProjectId, ThreadId } from "@getpaperplane/contracts";
import { AgentScope } from "@getpaperplane/shared/AgentScope";
import * as IdAllocator from "@getpaperplane/provider-core/server/IdAllocator";
import * as ProviderEventLoggers from "@getpaperplane/provider-core/server/ProviderEventLoggers";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import wire from "../../provider/testFixtures/codexMultiAgentWire.json" with { type: "json" };

const settings = Schema.decodeSync(CodexSettings)({});

for (const scenario of [
  { name: "SIGKILL mid-turn", active: true, signal: "SIGKILL" },
  { name: "clean exit mid-turn", active: true, signal: "SIGTERM", exitCode: 0 },
  { name: "nonzero exit mid-turn", active: true, signal: "SIGTERM", exitCode: 17 },
  { name: "clean exit while idle", active: false, signal: "SIGTERM", exitCode: 0 },
  {
    name: "confirmed OOM with exit code zero",
    active: true,
    signal: "SIGTERM",
    exitCode: 0,
    oom: true,
  },
] as const) {
  it.live(`fails and recovers Codex after ${scenario.name}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "paperplane-codex-recovery-" });
      const scriptPath = `${cwd}/script.json`;
      const writeScript = (retry: boolean) =>
        fs.writeFileString(
          scriptPath,
          JSON.stringify({
            rootThreadId: wire.rootThreadId,
            notifications: [],
            holdTurnOpen: !retry && scenario.active,
            turnIds: [retry ? "recovered-turn" : "first-turn"],
            ...("exitCode" in scenario ? { exitCodeOnSigterm: scenario.exitCode } : {}),
          }),
        );
      yield* writeScript(false);
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handles: Array<ChildProcessSpawner.ChildProcessHandle> = [];
      const testSpawner = ChildProcessSpawner.make(() =>
        spawner
          .spawn(
            ChildProcess.make(
              process.execPath,
              [`${import.meta.dirname}/../../provider/testFixtures/codexCollabMockPeer.mjs`],
              { cwd, env: { PAPERPLANE_CODEX_COLLAB_SCRIPT: scriptPath }, extendEnv: true },
            ),
          )
          .pipe(Effect.tap((handle) => Effect.sync(() => handles.push(handle)))),
      );
      const modelSelection = {
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        model: "gpt-5.4",
      };
      const layerRegistry = ProviderAdapterRegistry.layerFromAdaptersEffect(
        Effect.gen(function* () {
          return [
            yield* CodexAdapterV2.makeCodexAdapterV2({
              instanceId: modelSelection.instanceId,
              settings,
              environment: {},
              clientFactory: yield* CodexAdapterV2.CodexAppServerClientFactory,
              crypto: yield* Crypto.Crypto,
              fileSystem: fs,
              idAllocator: yield* IdAllocator.IdAllocatorV2,
              serverConfig: yield* ServerConfig.ServerConfig,
            }),
          ];
        }),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            ServerConfig.layerTest(cwd, cwd),
            CodexAdapterV2.layerAppServerClientFactory.pipe(
              Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, testSpawner)),
              Layer.provide(
                Layer.succeed(
                  ProviderEventLoggers.ProviderEventLoggers,
                  ProviderEventLoggers.NoOpProviderEventLoggers,
                ),
              ),
            ),
          ),
        ),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const threadId = ThreadId.make("thread:codex-recovery");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create:codex-recovery"),
          threadId,
          projectId: ProjectId.make("project:codex-recovery"),
          title: "Codex recovery",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const send = (text: string) =>
          orchestrator
            .dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`send:${text}`),
              threadId,
              messageId: MessageId.make(`message:${text}`),
              text,
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            })
            .pipe(Effect.andThen(worker.drain()));
        const waitForRun = (afterSequence: number, status: "waiting" | "failed") =>
          eventSink.stream({ threadId, afterSequence, eventType: "run.updated" }).pipe(
            Stream.filter(
              ({ event }) => event.type === "run.updated" && event.payload.status === status,
            ),
            Stream.take(1),
            Stream.runDrain,
          );
        const firstSequence = yield* eventSink.latestSequence();
        yield* send("first");
        if (!scenario.active) {
          yield* waitForRun(firstSequence, "waiting");
          yield* worker.drain();
        }
        const before = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(before.runs.at(-1)?.status, scenario.active ? "running" : "completed");
        assert.lengthOf(handles, 1);
        const sessionId = before.providerSessions.at(-1)!.id;
        const afterSequence = yield* eventSink.latestSequence();
        // Only signal the exact process handle this test spawned.
        yield* handles[0]!.kill({ killSignal: scenario.signal });
        yield* eventSink
          .stream({ threadId, afterSequence, eventType: "provider-session.updated" })
          .pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "provider-session.updated" && event.payload.status === "error",
            ),
            Stream.take(1),
            Stream.runDrain,
          );
        if (scenario.active) yield* waitForRun(afterSequence, "failed");
        yield* worker.drain();
        assert.isTrue(Option.isNone(yield* manager.get(sessionId)));
        const failed = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(failed.runs.at(-1)?.status, scenario.active ? "failed" : "completed");
        const error = failed.turnItems.find((item) => item.type === "error");

        if (scenario.active) {
          assert.isDefined(error);
          if ("oom" in scenario) {
            assert.equal(error?.failure.code, "oom_kill");
            assert.equal(error?.failure.message, "Killed: out of memory.");
          } else {
            assert.include(error?.failure.message ?? "", "The Codex app-server exited");
            assert.include(
              error?.failure.message ?? "",
              "exitCode" in scenario ? `exit code ${scenario.exitCode}` : "SIGKILL",
            );
          }
        } else assert.isUndefined(error);

        yield* writeScript(true);
        const retrySequence = yield* eventSink.latestSequence();
        yield* send("retry");
        // Provider completion first persists waiting and enqueues checkpoint
        // capture. Drain that effect before expecting the final completed run.
        yield* waitForRun(retrySequence, "waiting");
        yield* worker.drain();
        assert.lengthOf(handles, 2);
        assert.notEqual(handles[0]!.pid, handles[1]!.pid);
        const recovered = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(recovered.runs.at(-1)?.status, "completed");
        assert.equal(recovered.providerSessions.at(-1)?.status, "ready");
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "codex-session-recovery", runtimePolicyOverride: { cwd } },
            layerRegistry,
            { runEffectWorker: false },
          ),
        ),
        Effect.provideService(AgentScope, {
          ...(yield* AgentScope),
          oomKill: () => Effect.succeed("oom" in scenario ? "confirmed" : null),
        }),
      );
    }).pipe(Effect.timeout("20 seconds"), Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
