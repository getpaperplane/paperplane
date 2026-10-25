import { WS_METHODS } from "@getpaperplane/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentRpcUnavailableError, request } from "../rpc/client.ts";
import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";

/** A just-paired sandbox is registered before its socket connects. */
const awaitSession = EnvironmentSupervisor.pipe(
  Effect.flatMap((supervisor) =>
    SubscriptionRef.changes(supervisor.session).pipe(
      Stream.filter(Option.isSome),
      Stream.runHead,
      Effect.timeoutOrElse({
        duration: "60 seconds",
        orElse: () =>
          Effect.fail(
            new EnvironmentRpcUnavailableError({
              environmentId: supervisor.target.environmentId,
              message: "The sandbox didn't accept a connection within a minute. Try again.",
            }),
          ),
      }),
    ),
  ),
);

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
      execute: (input) =>
        awaitSession.pipe(Effect.andThen(request(WS_METHODS.serverGetConfig, input))),
    }),
  };
}
