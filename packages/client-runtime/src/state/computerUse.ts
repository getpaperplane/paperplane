import {
  type ComputerDesktop,
  type ComputerDesktopsState,
  type ThreadId,
  WS_METHODS,
} from "@getpaperplane/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { DeviceHubAccess } from "../device/hubAccess.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createComputerUseEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Cua Driver installation and desktop readiness on the environment's host. */
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:computer-use:status",
      tag: WS_METHODS.computerUseStatus,
    }),
    control: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer-use:control",
      tag: WS_METHODS.computerUseControl,
      scheduler: createAtomCommandScheduler(),
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    /** Server-pushed private desktops (Linux containers, macOS VMs). Never carries credentials. */
    desktops: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:computer-use:desktops",
      tag: WS_METHODS.subscribeComputerDesktops,
    }),
    /** Viewer path and VNC password for one desktop; fetch it fresh on every connect. */
    viewer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer-use:viewer",
      tag: WS_METHODS.computerDesktopViewer,
    }),
  };
}

export const EMPTY_COMPUTER_DESKTOPS_STATE: ComputerDesktopsState = {
  mode: "unavailable",
  desktops: [],
  revision: 0,
};

/** Desktops a thread may watch: its own, plus the shared setup desktop. */
export function threadComputerDesktops(
  state: ComputerDesktopsState,
  threadId: ThreadId | string,
): ReadonlyArray<ComputerDesktop> {
  // filter() copies, so sorting in place never touches the snapshot.
  return state.desktops
    .filter(
      (desktop) =>
        desktop.role === "setup" || (desktop.role === "thread" && desktop.threadId === threadId),
    )
    .sort(
      (a, b) =>
        Number(a.role === "setup") - Number(b.role === "setup") ||
        a.startedAt.localeCompare(b.startedAt),
    );
}

/**
 * The RFB WebSocket URL for a viewer path, on the same environment origin and
 * with the same `wsTicket` the device streams use.
 */
export function computerDesktopViewerUrl(access: DeviceHubAccess, path: string): string {
  const url = new URL(access.wsBase);
  url.pathname = path;
  url.search = "";
  url.hash = "";
  // Device-only parameters such as hostId mean nothing to the desktop proxy.
  const ticket = access.query.wsTicket;
  if (ticket !== undefined) url.searchParams.set("wsTicket", ticket);
  return url.toString();
}
