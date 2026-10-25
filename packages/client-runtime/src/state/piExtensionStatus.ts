import { WS_METHODS } from "@getpaperplane/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

/** Share one live subscription per environment/thread while a client is viewing it. */
export function createPiExtensionStatusAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    snapshot: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:pi-extension-status",
      tag: WS_METHODS.piExtensionStatusesSubscribe,
      // No background subscriptions or stale status cache for unmounted threads.
      idleTtlMs: 0,
    }),
  };
}
