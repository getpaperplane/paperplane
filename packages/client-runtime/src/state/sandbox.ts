import { WS_METHODS } from "@rove-code/contracts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { Atom } from "effect/unstable/reactivity";
import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";

/** Shared by web/desktop and mobile. Inventory reads only local saved state;
 * neither rendering settings nor saving credentials starts cloud compute. */
export function createSandboxEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  return {
    inventory: createEnvironmentRpcCommand(runtime, {
      label: "sandbox:inventory",
      tag: WS_METHODS.sandboxInventory,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "sandbox:configure",
      tag: WS_METHODS.sandboxConfigure,
      scheduler,
      concurrency,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "sandbox:create",
      tag: WS_METHODS.sandboxCreate,
      scheduler,
      concurrency,
    }),
    action: createEnvironmentRpcCommand(runtime, {
      label: "sandbox:action",
      tag: WS_METHODS.sandboxAction,
      scheduler,
      concurrency,
    }),
    link: createEnvironmentRpcCommand(runtime, {
      label: "sandbox:link",
      tag: WS_METHODS.sandboxLink,
      scheduler,
      concurrency,
    }),
    getConfig: createEnvironmentRpcCommand(runtime, {
      label: "sandbox:connection-config",
      tag: WS_METHODS.serverGetConfig,
    }),
  };
}
