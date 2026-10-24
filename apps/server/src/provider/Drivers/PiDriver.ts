/** In-process SDK Pi driver; one isolated worker per configured instance (ADR 0001). */
// @effect-diagnostics nodeBuiltinImport:off - Resolve SDK agent-directory identities with the same Node path semantics as the worker.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as HostProcess from "@getpaperplane/shared/HostProcess";
import * as ProviderHost from "@getpaperplane/provider-core/server/ProviderHost";
import * as IdAllocator from "@getpaperplane/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@getpaperplane/provider-core/server/McpProviderSessions";
import * as FileSystem from "effect/FileSystem";
import {
  PiCatalogError,
  PiSettings,
  ProviderDriverKind,
  type ServerProvider,
} from "@getpaperplane/contracts";
import type { ProviderDriver, ProviderInstance } from "@getpaperplane/provider-core/server/driver";
import { ProviderDriverError } from "@getpaperplane/provider-core/server/errors";
import type { ServerProviderDraft } from "@getpaperplane/provider-core/server/snapshotProbe";
import { makeManagedServerProvider } from "@getpaperplane/provider-core/server/managedProvider";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@getpaperplane/provider-core/server/maintenanceResolver";
import { mergeProviderInstanceEnvironment } from "@getpaperplane/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@getpaperplane/provider-core/server/pathExpansion";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makePiAdapterV2 } from "../../orchestration-v2/Adapters/PiAdapterV2.ts";
import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import { acquirePiResource, disposePiResource } from "../Layers/PiLifecycle.ts";
import { LazyPiRuntime, PiRuntimeProcess } from "../Layers/PiRuntimeProcess.ts";
import { PI_CONFIG_DIR } from "../PiSdkMetadata.ts";
import * as PiExtensionStatuses from "../PiExtensionStatuses.ts";
import {
  buildInitialPiProviderSnapshot,
  checkPiProviderStatus,
  type PiDiscoveryClient,
} from "../Layers/PiProvider.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const DRIVER_KIND = ProviderDriverKind.make("pi");
const decodePiSettings = Schema.decodeSync(PiSettings);
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: "@earendil-works/pi-coding-agent",
});
export type PiDriverEnv =
  | ServerConfig
  | ServerSettingsService
  | ProviderHost.ProviderHost
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | PiExtensionStatuses.PiExtensionStatuses
  | FileSystem.FileSystem;
export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Pi", supportsMultipleInstances: true },
  configSchema: PiSettings,
  defaultConfig: () => decodePiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const home = yield* HostProcess.HomeDirectory;
      const processEnv = yield* mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled };
      const agentDir = NodePath.resolve(
        expandHomePath(
          config.agentDir ||
            processEnv.PI_CODING_AGENT_DIR ||
            NodePath.join(home, PI_CONFIG_DIR, "agent"),
          home,
        ),
      );
      const continuationIdentity = {
        driverKind: DRIVER_KIND,
        continuationKey: `pi:agent:${agentDir}`,
      };
      const stamp = (snapshot: ServerProviderDraft): ServerProvider => ({
        ...snapshot,
        instanceId,
        driver: DRIVER_KIND,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      });
      const executable = yield* HostProcess.IsExecutable;
      const runtime = enabled
        ? new LazyPiRuntime(
            () => PiRuntimeProcess.create({ ...effectiveConfig, agentDir }, executable, processEnv),
            60_000,
          )
        : undefined;
      const host = () =>
        runtime
          ? runtime.get()
          : Promise.reject(new Error("Pi is disabled in Paperplane settings."));
      if (runtime)
        yield* Effect.acquireRelease(
          acquirePiResource(
            () => runtime.get(),
            () => runtime.dispose(),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail: "Failed to load the Pi SDK instance.",
                  cause,
                }),
            ),
          ),
          () => disposePiResource(() => runtime.dispose()),
        );
      const orchestrationAdapter = yield* makePiAdapterV2({
        instanceId,
        defaultModel: effectiveConfig.model,
        defaultThinkingLevel: effectiveConfig.thinkingLevel,
        createSession: (input, mcp) =>
          host().then((worker) =>
            worker.createSession(
              {
                ...input,
                agentDir,
                disabledExtensions: effectiveConfig.disabledExtensions,
              },
              false,
              mcp,
            ),
          ),
      });
      const textGeneration = yield* makePiTextGeneration(effectiveConfig, {
        createSession: (input) =>
          host().then((worker) =>
            worker.createSession({ ...input, agentDir, resumeSessionId: undefined }, true),
          ),
      });
      const discovery: PiDiscoveryClient = {
        discover: (input) => host().then((worker) => worker.discover(input)),
      };
      const settings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PiSettings>>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE),
        getSettings: settings.getSettings,
        streamSettings: settings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        refreshOnInterval: false,
        initialSnapshot: (settings) =>
          buildInitialPiProviderSnapshot(settings.provider).pipe(Effect.map(stamp)),
        checkProvider: checkPiProviderStatus(
          effectiveConfig,
          {
            getCatalogModels: (thinking) =>
              host().then((worker) => worker.getCatalogModels(thinking)),
          },
          discovery,
        ).pipe(Effect.map(stamp)),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build the Pi SDK snapshot.",
              cause,
            }),
        ),
      );
      if (runtime) {
        const changes = yield* Queue.unbounded<void>();
        const unsubscribe = runtime.onChange(() => {
          Queue.offerUnsafe(changes, undefined);
        });
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        yield* Queue.take(changes).pipe(
          Effect.flatMap(() => snapshot.refresh),
          Effect.forever,
          Effect.forkScoped,
        );
      }
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration,
        snapshotForCwd: (cwd) =>
          Effect.gen(function* () {
            const current = yield* snapshot.getSnapshot;
            if (!enabled) return current;
            const resources = yield* Effect.tryPromise({
              try: () => discovery.discover({ cwd }),
              catch: (cause) =>
                new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail: "Failed to discover project Pi resources.",
                  cause,
                }),
            });
            return {
              ...current,
              skills: resources.skills,
              slashCommands: [
                { name: "compact", description: "Compact the conversation context" },
                ...resources.slashCommands.filter((command) => command.name !== "compact"),
              ],
            };
          }),
        piCatalog: {
          getCatalog: () =>
            Effect.tryPromise({
              try: () => host().then((worker) => worker.getCatalog()),
              catch: () => new PiCatalogError({ message: "Failed to read the Pi SDK catalog." }),
            }),
          refreshCatalog: () =>
            Effect.tryPromise({
              try: () => host().then((worker) => worker.refreshCatalog()),
              catch: () => new PiCatalogError({ message: "Failed to refresh the Pi SDK catalog." }),
            }),
        },
      } satisfies ProviderInstance;
    }),
};
