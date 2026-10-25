import * as ProviderRegistry from "../ProviderRegistry.ts";
import { PiCatalogError, type ServerProvider } from "@getpaperplane/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@getpaperplane/provider-core/server/maintenanceResolver";

const makeProviderRegistryMock = (
  providers: ReadonlyArray<ServerProvider> = [],
): ProviderRegistry.ProviderRegistry["Service"] => ({
  piCatalog: () => Effect.fail(new PiCatalogError({ message: "Pi is unavailable in this test." })),
  refreshPiCatalog: () =>
    Effect.fail(new PiCatalogError({ message: "Pi is unavailable in this test." })),
  getProviders: Effect.succeed(providers),
  refresh: () => Effect.succeed(providers),
  refreshInstance: () => Effect.succeed(providers),
  refreshWorkspaceSnapshot: () => Effect.succeed(providers),
  getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
    Effect.succeed(makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null })),
  setProviderMaintenanceActionState: () => Effect.succeed(providers),
  streamChanges: Stream.empty,
});

export const layer = (providers: ReadonlyArray<ServerProvider> = []) =>
  Layer.succeed(ProviderRegistry.ProviderRegistry, makeProviderRegistryMock(providers));
