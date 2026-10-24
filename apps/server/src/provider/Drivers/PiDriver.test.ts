// @effect-diagnostics nodeBuiltinImport:off - SDK filesystem fixture.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it, assert } from "@effect/vitest";
import { describe, beforeEach, afterEach, vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as IdAllocator from "@getpaperplane/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@getpaperplane/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@getpaperplane/provider-testing/TestProviderHost";
import { ProviderInstanceId } from "@getpaperplane/contracts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeSdkDiscoveryClient } from "../Layers/PiDiscovery.ts";
import { PiDriver } from "./PiDriver.ts";
import * as PiExtensionStatuses from "../PiExtensionStatuses.ts";
const testLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "rove-pi-driver-" }),
  ServerSettingsService.layerTest(),
  TestProviderHost.layer({ runBackgroundWork: false }),
  IdAllocator.layer,
  McpProviderSessions.layer,
  PiExtensionStatuses.layer,
).pipe(Layer.provideMerge(NodeServices.layer));
describe("Pi SDK driver", () => {
  let root: string, agentDir: string;
  beforeEach(() => {
    root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-pi-discovery-")),
    );
    agentDir = NodePath.join(root, "agent");
    NodeFS.mkdirSync(NodePath.join(agentDir, "skills", "fixture-skill"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(agentDir, "skills", "fixture-skill", "SKILL.md"),
      "---\nname: fixture-skill\ndescription: A fixture skill\n---\n\nBody\n",
    );
    NodeFS.mkdirSync(NodePath.join(agentDir, "prompts"));
    NodeFS.writeFileSync(
      NodePath.join(agentDir, "prompts", "greet.md"),
      "---\ndescription: Greet someone\n---\n\nHello\n",
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_OFFLINE", "1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    NodeFS.rmSync(root, { recursive: true, force: true });
  });
  it("lists global resources without loading a random project's resources", async () => {
    const client = makeSdkDiscoveryClient(() => [
      { name: "greet", description: "Extension command wins" },
    ]);
    const discovered = await client.discover({ cwd: undefined });
    assert.deepEqual(discovered.slashCommands, [
      { name: "greet", description: "Extension command wins" },
    ]);
    assert.strictEqual(
      discovered.skills.find((skill) => skill.name === "fixture-skill")?.scope,
      "user",
    );
    const cwd = NodePath.join(root, "project");
    NodeFS.mkdirSync(NodePath.join(cwd, ".pi", "prompts"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".pi", "prompts", "local.md"),
      "---\ndescription: Project local\n---\n\nLocal\n",
    );
    assert.isFalse(
      (await client.discover({ cwd: undefined })).slashCommands.some(
        (command) => command.name === "local",
      ),
    );
    assert.isTrue(
      (await client.discover({ cwd })).slashCommands.some((command) => command.name === "local"),
    );
    assert.isFalse(NodeFS.existsSync(NodePath.join(agentDir, "settings.json")));
  });
  it.effect("groups compatible directories and does not load a disabled instance", () =>
    Effect.gen(function* () {
      const create = (id: string, directory: string) =>
        PiDriver.create({
          instanceId: ProviderInstanceId.make(id),
          displayName: undefined,
          enabled: false,
          environment: [],
          config: { ...PiDriver.defaultConfig(), agentDir: directory },
        });
      const first = yield* create("one", agentDir);
      const second = yield* create("two", NodePath.join(agentDir, "."));
      assert.deepEqual(first.continuationIdentity, second.continuationIdentity);
      assert.deepEqual((yield* first.snapshot.getSnapshot).supportedRuntimeModes, ["full-access"]);
      assert.strictEqual(first.orchestrationAdapter.driver, "pi");
      assert.isDefined(first.piCatalog);
      assert.strictEqual(
        (yield* first.piCatalog!.getCatalog().pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
