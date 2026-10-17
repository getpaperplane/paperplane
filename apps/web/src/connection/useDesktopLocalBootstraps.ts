import type { DesktopEnvironmentBootstrap } from "@rove-code/contracts";
import { useEffect, useState } from "react";

import {
  desktopPushesBootstraps,
  readDesktopSecondaryBootstraps,
  subscribeDesktopSecondaryBootstraps,
} from "./desktopLocal";

const DESKTOP_LOCAL_BOOTSTRAP_POLL_MS = 2_000;

type VisibilityDocument = Pick<
  Document,
  "visibilityState" | "addEventListener" | "removeEventListener"
>;

/**
 * Call `read` now and every `intervalMs` while the document is visible. Polling
 * stops while it is hidden and resumes with an immediate read when it is shown
 * again. Returns the cleanup.
 */
export function pollWhileVisible(
  read: () => void,
  intervalMs: number,
  doc: VisibilityDocument = document,
): () => void {
  let interval: ReturnType<typeof setInterval> | undefined;
  const sync = () => {
    clearInterval(interval);
    interval = undefined;
    if (doc.visibilityState === "hidden") return;
    read();
    interval = setInterval(read, intervalMs);
  };
  sync();
  doc.addEventListener("visibilitychange", sync);
  return () => {
    doc.removeEventListener("visibilitychange", sync);
    clearInterval(interval);
  };
}

/**
 * Reactively track the desktop's secondary local backends (e.g. a parallel WSL
 * backend). The desktop pushes topology changes, so the renderer keeps a cached
 * snapshot and never polls over synchronous IPC. Desktops that predate the
 * push event fall back to re-reading on an interval while the window is
 * visible. Failed reads retain the latest successful snapshot, while a
 * successful empty read clears it. Use this instead of polling the bridge ad
 * hoc so every renderer consumer reads the same topology.
 */
export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  const [bootstraps, setBootstraps] = useState<ReadonlyArray<DesktopEnvironmentBootstrap>>(
    readDesktopSecondaryBootstraps,
  );

  useEffect(() => {
    // Browsers have no desktop topology to track.
    if (!window.desktopBridge) return;
    if (desktopPushesBootstraps()) {
      const sync = () => setBootstraps(readDesktopSecondaryBootstraps());
      const unsubscribe = subscribeDesktopSecondaryBootstraps(sync);
      sync();
      return unsubscribe;
    }
    return pollWhileVisible(
      () => setBootstraps(readDesktopSecondaryBootstraps()),
      DESKTOP_LOCAL_BOOTSTRAP_POLL_MS,
    );
  }, []);

  return bootstraps;
}
