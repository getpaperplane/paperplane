import type { ConnectionTarget } from "@getpaperplane/client-runtime/connection";
import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopEnvironmentBootstrap,
} from "@getpaperplane/contracts";

/**
 * Desktop-local secondary backends (e.g. a parallel WSL backend) are registered
 * by the connection platform source as bearer connections whose id carries this
 * prefix. It is the renderer's single signal that an environment is a
 * host-managed local backend rather than a user-saved remote, SSH, or relay
 * environment.
 *
 * Keep this the one source of truth: the producer (`connection/platform.ts`)
 * mints ids via {@link desktopLocalConnectionId} and every consumer classifies
 * via {@link isDesktopLocalConnectionTarget}, so the convention can never drift
 * between the two.
 */
const DESKTOP_LOCAL_CONNECTION_ID_PREFIX = "local:";

export function desktopLocalConnectionId(backendId: string): string {
  return `${DESKTOP_LOCAL_CONNECTION_ID_PREFIX}${backendId}`;
}

export function isDesktopLocalConnectionTarget(
  target: ConnectionTarget,
): target is Extract<ConnectionTarget, { readonly _tag: "BearerConnectionTarget" }> {
  return (
    target._tag === "BearerConnectionTarget" &&
    target.connectionId.startsWith(DESKTOP_LOCAL_CONNECTION_ID_PREFIX)
  );
}

export function desktopLocalBackendId(target: ConnectionTarget): string | null {
  return isDesktopLocalConnectionTarget(target)
    ? target.connectionId.slice(DESKTOP_LOCAL_CONNECTION_ID_PREFIX.length)
    : null;
}

export function isWslConnectionTarget(target: ConnectionTarget): boolean {
  return desktopLocalBackendId(target)?.startsWith("wsl:") === true;
}

export type DesktopSecondaryBootstrapsRead =
  | {
      readonly _tag: "Success";
      readonly bootstraps: ReadonlyArray<DesktopEnvironmentBootstrap>;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
    };

type DesktopBootstrapsBridge = Pick<
  DesktopBridge,
  "getLocalEnvironmentBootstraps" | "onLocalEnvironmentBootstrapsChanged"
>;

export interface DesktopSecondaryBootstrapsReader {
  readonly readResult: () => DesktopSecondaryBootstrapsRead;
  readonly readSnapshot: () => ReadonlyArray<DesktopEnvironmentBootstrap>;
  /** Every bootstrap including the primary as of the latest `readResult`. */
  readonly readAll: () => ReadonlyArray<DesktopEnvironmentBootstrap>;
  /** Called after the secondary snapshot changes, including pushed updates. */
  readonly subscribe: (listener: () => void) => () => void;
}

function sameBootstrap(a: DesktopEnvironmentBootstrap, b: DesktopEnvironmentBootstrap): boolean {
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.runningDistro === b.runningDistro &&
    a.httpBaseUrl === b.httpBaseUrl &&
    a.wsBaseUrl === b.wsBaseUrl &&
    a.bootstrapToken === b.bootstrapToken
  );
}

function sameBootstraps(
  a: ReadonlyArray<DesktopEnvironmentBootstrap>,
  b: ReadonlyArray<DesktopEnvironmentBootstrap>,
): boolean {
  return a.length === b.length && a.every((entry, index) => sameBootstrap(entry, b[index]!));
}

/**
 * Build a topology reader whose snapshot advances only after successful bridge
 * reads. A successful empty read is authoritative; a thrown read preserves the
 * previous snapshot so UI consumers cannot temporarily disagree with the
 * platform's retained registrations.
 *
 * When the desktop pushes changes, the first successful synchronous read seeds
 * a cache and later reads are served from it, so no synchronous IPC runs after
 * boot. Older desktops without the push event are re-read on every call.
 */
export function createDesktopSecondaryBootstrapsReader(
  resolveBridge: () => DesktopBootstrapsBridge | undefined,
): DesktopSecondaryBootstrapsReader {
  let all: ReadonlyArray<DesktopEnvironmentBootstrap> = [];
  let snapshot: ReadonlyArray<DesktopEnvironmentBootstrap> = [];
  let pushing = false;
  let unsubscribe: (() => void) | undefined;
  const listeners = new Set<() => void>();

  const ingest = (list: ReadonlyArray<DesktopEnvironmentBootstrap>) => {
    if (!sameBootstraps(list, all)) all = list;
    const secondaries = list.filter((entry) => entry.id !== PRIMARY_LOCAL_ENVIRONMENT_ID);
    if (!sameBootstraps(secondaries, snapshot)) {
      snapshot = secondaries;
      for (const listener of listeners) listener();
    }
  };

  const readResult = (): DesktopSecondaryBootstrapsRead => {
    const bridge = resolveBridge();
    if (bridge === undefined) {
      unsubscribe?.();
      unsubscribe = undefined;
      pushing = false;
      if (snapshot.length > 0 || all.length > 0) ingest([]);
      return { _tag: "Success", bootstraps: snapshot };
    }
    if (pushing) return { _tag: "Success", bootstraps: snapshot };
    try {
      ingest(bridge.getLocalEnvironmentBootstraps());
      if (bridge.onLocalEnvironmentBootstrapsChanged !== undefined) {
        // Subscribe after the seed read; a push that lands in between is newer
        // than the seed and simply replaces it.
        unsubscribe = bridge.onLocalEnvironmentBootstrapsChanged(ingest);
        pushing = true;
      }
      return { _tag: "Success", bootstraps: snapshot };
    } catch (cause) {
      return { _tag: "Failure", cause };
    }
  };

  return {
    readResult,
    readSnapshot: () => {
      const result = readResult();
      return result._tag === "Success" ? result.bootstraps : snapshot;
    },
    readAll: () => all,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const desktopSecondaryBootstrapsReader = createDesktopSecondaryBootstrapsReader(
  () => window.desktopBridge,
);

/** True when the desktop pushes topology changes, so polling is unnecessary. */
export function desktopPushesBootstraps(): boolean {
  return window.desktopBridge?.onLocalEnvironmentBootstrapsChanged !== undefined;
}

/** Subscribe to secondary topology changes (pushes included). */
export function subscribeDesktopSecondaryBootstraps(listener: () => void): () => void {
  desktopSecondaryBootstrapsReader.readResult();
  return desktopSecondaryBootstrapsReader.subscribe(listener);
}

/**
 * Every desktop bootstrap including the primary. Throws when the bridge read
 * fails before the first success, like the bridge call it replaces.
 */
export function readDesktopBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  const bridge = window.desktopBridge;
  if (bridge === undefined) return [];
  const result = desktopSecondaryBootstrapsReader.readResult();
  if (result._tag === "Failure") throw result.cause;
  return desktopSecondaryBootstrapsReader.readAll();
}

/** Read the topology while preserving failures for platform cache policy. */
export function readDesktopSecondaryBootstrapsResult(): DesktopSecondaryBootstrapsRead {
  return desktopSecondaryBootstrapsReader.readResult();
}

/** Read the latest successful topology snapshot for renderer consumers. */
export function readDesktopSecondaryBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return desktopSecondaryBootstrapsReader.readSnapshot();
}
