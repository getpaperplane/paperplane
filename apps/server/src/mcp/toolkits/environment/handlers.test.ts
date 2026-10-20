import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@rove-code/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as HostHealth from "../../../diagnostics/HostHealth.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:preferences");
const threadId = ThreadId.make("thread:preferences");
const caller: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "provider:preferences",
  thread: {
    threadId,
    providerSessionId: "provider:preferences",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};
const layerEnvironment = Layer.mock(Environment.ServerEnvironment)({
  getDescriptor: Effect.succeed({
    environmentId,
    label: "Test",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0",
    capabilities: { repositoryIdentity: false },
  }),
});

for (const available of [true, false, "interrupted"] as const) {
  it.effect(
    `reads environment preferences with host health ${available === true ? "available" : available === false ? "unavailable" : "interrupted"}`,
    () =>
      Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        const read = toolkit
          .handle("rove_environment_read", {})
          .pipe(Stream.unwrap, Stream.runCollect);
        if (available === "interrupted") {
          const result = yield* Effect.exit(read);
          expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true);
          return;
        }
        const messages = yield* read;
        const result = messages.at(-1)?.result;
        expect(result).toMatchObject({
          environmentId,
          preferences: {
            newWorktreesStartFromOrigin: DEFAULT_SERVER_SETTINGS.newWorktreesStartFromOrigin,
          },
        });
        if (available) expect(result).toHaveProperty("hostHealth.totalMemoryBytes", 1024);
        else expect(result).not.toHaveProperty("hostHealth");
      }).pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                layerEnvironment,
                ThreadCommandExecutor.layer,
                Settings.layerTest(),
                Layer.succeed(McpInvocationContext.McpInvocationContext, caller),
                Layer.mock(ThreadManagement.ThreadManagementService)({
                  getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
                }),
                Layer.succeed(HostHealth.HostHealth, {
                  read:
                    available === true
                      ? Effect.succeed({
                          sampledAt: 0,
                          totalMemoryBytes: 1024,
                          availableMemoryBytes: 512,
                          swapTotalBytes: null,
                          swapFreeBytes: null,
                          memoryPressure: false,
                          roveMemory: null,
                          findings: [],
                        })
                      : available === "interrupted"
                        ? Effect.interrupt
                        : Effect.die("host check failed"),
                  changes: Stream.empty,
                }),
              ),
            ),
          ),
        ),
      ),
  );
}

it.effect("updates preferences for a thread caller through the /mcp registration", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "rove_environment_preferences_update",
        arguments: { newWorktreesStartFromOrigin: true },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
        Effect.provideService(
          McpSchema.McpServerClient,
          McpSchema.McpServerClient.of({
            clientId: 1,
            protocolVersion: "2025-06-18",
            clientCapabilities: {},
            clientInfo: { name: "preferences", version: "1" },
            initializePayload: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "preferences", version: "1" },
            },
            getClient: Effect.die("unused"),
          }),
        ),
      );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ newWorktreesStartFromOrigin: true });
  }).pipe(
    Effect.provide(
      McpHttpServer.layerEnvironmentToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
          }),
        ),
        Layer.provide(layerEnvironment),
        Layer.provide(Layer.mock(HostHealth.HostHealth)({})),
        Layer.provide(Settings.layerTest()),
      ),
    ),
  ),
);

it.effect("refuses a preferences update when the caller's turn ends while it waits", () =>
  Effect.gen(function* () {
    const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
    const updates = yield* Ref.make(0);
    // Completes once the declaration's own check has read the caller.
    const checked = yield* Deferred.make<void>();
    const layerDependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      Layer.mock(HostHealth.HostHealth)({}),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:preferences",
        thread: {
          threadId,
          providerSessionId: "provider:preferences",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Ref.get(caller).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
      }),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        updateSettings: () =>
          Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // A turn-completion command holds the thread's lock.
      const holder = yield* executor
        .withLock(
          threadId,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const update = yield* toolkit
        .handle("rove_environment_preferences_update", { newWorktreesStartFromOrigin: true })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.forkChild);
      // The update passed its first check and waits for the lock; the turn then ends.
      yield* Deferred.await(checked);
      yield* Ref.update(caller, (shell) => ({ ...shell, activeRunId: null }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      const result = yield* Fiber.join(update);
      expect(result.at(-1)?.result).toMatchObject({ code: "parent_not_active" });
      expect(yield* Ref.get(updates)).toBe(0);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);
