import { useMemo, useSyncExternalStore } from "react";

// setTimeout delays are signed 32-bit; longer ones fire immediately.
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Whether the clock has reached `atMs` (epoch milliseconds). One timeout per
 * deadline re-renders the caller when it passes, instead of a ticking clock
 * re-rendering it every minute. Waking a hidden or sleeping machine re-checks.
 */
export function useClockReached(atMs: number | null): boolean {
  const clock = useMemo(() => {
    const reached = () => atMs !== null && Date.now() >= atMs;
    return {
      subscribe: (notify: () => void) => {
        if (atMs === null || reached()) return () => {};
        let timer: number | undefined;
        const arm = () => {
          window.clearTimeout(timer);
          timer = window.setTimeout(
            () => (reached() ? notify() : arm()),
            Math.min(Math.max(0, atMs - Date.now()), MAX_TIMEOUT_MS),
          );
        };
        const onVisibilityChange = () => {
          if (document.visibilityState === "hidden") return;
          if (reached()) notify();
          else arm();
        };
        arm();
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () => {
          window.clearTimeout(timer);
          document.removeEventListener("visibilitychange", onVisibilityChange);
        };
      },
      getSnapshot: reached,
    };
  }, [atMs]);
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}
