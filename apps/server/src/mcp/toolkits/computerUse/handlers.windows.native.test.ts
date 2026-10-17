import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@rove-code/contracts";
import { Platform as HostProcessPlatform } from "@rove-code/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as CuaDriver from "../../../computerUse/CuaDriver.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { layerComputerUseToolkit } from "../../McpHttpServer.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";

const decodeApps = Schema.decodeUnknownSync(
  Schema.Struct({ apps: Schema.NonEmptyArray(Schema.Unknown) }),
);

it.live.skipIf(
  process.env.ROVE_TEST_NATIVE_CUA !== "1" || HostProcessPlatform.defaultValue() !== "win32",
)(
  "reads the Windows desktop and refuses pid-only keyboard input before driver delivery",
  () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const client = McpSchema.McpServerClient.of({
        clientId: 1,
        clientCapabilities: {},
        clientInfo: { name: "rove-windows-verification", version: "1" },
        protocolVersion: "2025-06-18",
        initializePayload: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "rove-windows-verification", version: "1" },
        },
        getClient: Effect.die("unused"),
      });
      const call = (tool: string, args: CuaDriver.CuaArguments = {}) =>
        server.callTool({ name: "computer_call", arguments: { tool, arguments: args } }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("windows-native-cua"),
            requestNamespace: "native-verification",
            thread: {
              threadId: ThreadId.make("windows-native-cua"),
              providerSessionId: "native-verification",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
            client: undefined,
            capabilities: new Set<McpInvocationContext.McpCapability>(),
            issuedAt: 1,
          }),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      const apps = yield* call("list_apps");
      expect(apps.isError).not.toBe(true);
      expect(decodeApps(apps.structuredContent).apps.length).toBeGreaterThan(0);
      const refused = yield* call("press_key", { pid: process.pid, key: "return" });
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({
        code: "background_only",
        executed: false,
        effect: "refused",
      });
      const state = yield* call("get_desktop_state", { max_image_dimension: 64 });
      expect(state.isError).not.toBe(true);
      expect(state.content.length).toBeGreaterThan(0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerComputerUseToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
          Layer.provide(CuaDriver.layer),
          Layer.provide(ServerSettings.layerTest({ enableAgentComputerUse: true })),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  180_000,
);
