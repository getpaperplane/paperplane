/**
 * Loads a lazily split module once the browser is idle, so a panel that is
 * likely to open is ready before its first use. Returns a cancel function for
 * effect cleanup.
 */
export function preloadWhenIdle(load: () => Promise<unknown>): () => void {
  const run = () => {
    load().catch(() => {});
  };
  // Safari has no requestIdleCallback.
  if ("requestIdleCallback" in window) {
    const handle = window.requestIdleCallback(run, { timeout: 5_000 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = setTimeout(run, 2_000);
  return () => clearTimeout(handle);
}
