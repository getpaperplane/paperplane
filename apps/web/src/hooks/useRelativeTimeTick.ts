import { useMemo, useSyncExternalStore } from "react";

type ClockSubscription = {
  intervalMs: number;
  nowMs: number;
  notify: () => void;
};

let timerId: number | null = null;
const subscriptions = new Set<ClockSubscription>();

function tick(force = false) {
  const nowMs = Date.now();
  for (const subscription of subscriptions) {
    if (nowMs === subscription.nowMs) continue;
    if (!force && nowMs - subscription.nowMs < subscription.intervalMs) continue;
    subscription.nowMs = nowMs;
    subscription.notify();
  }
}

function syncTimer() {
  if (timerId !== null) window.clearInterval(timerId);
  timerId = null;
  if (subscriptions.size === 0 || document.visibilityState === "hidden") return;
  const intervalMs = Math.min(...Array.from(subscriptions, (entry) => entry.intervalMs));
  timerId = window.setInterval(() => tick(), intervalMs);
}

function onVisibilityChange() {
  if (document.visibilityState !== "hidden") tick(true);
  syncTimer();
}

/**
 * Calls `onTick` with the current time every `intervalMs` from the shared,
 * visibility-paused clock, for labels that write the DOM instead of
 * re-rendering. Returns the unsubscribe function.
 */
export function subscribeRelativeTimeTick(
  intervalMs: number,
  onTick: (nowMs: number) => void,
): () => void {
  const subscription: ClockSubscription = {
    intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 1_000,
    nowMs: Date.now(),
    notify: () => onTick(subscription.nowMs),
  };
  subscriptions.add(subscription);
  if (subscriptions.size === 1) {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  syncTimer();
  return () => {
    if (!subscriptions.delete(subscription)) return;
    syncTimer();
    if (subscriptions.size === 0) {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}

/** One visibility-paused clock, with each label notified only at its requested cadence. */
export function useRelativeTimeTick(intervalMs = 1_000) {
  const clock = useMemo(() => {
    let nowMs = Date.now();
    return {
      subscribe: (notify: () => void) => {
        nowMs = Date.now();
        return subscribeRelativeTimeTick(intervalMs, (tickMs) => {
          nowMs = tickMs;
          notify();
        });
      },
      getSnapshot: () => nowMs,
    };
  }, [intervalMs]);
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}
