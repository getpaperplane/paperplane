import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useClockReached } from "./useClockReached";

const store = vi.hoisted(() => ({
  subscribe: null as ((listener: () => void) => () => void) | null,
  getSnapshot: null as (() => boolean) | null,
}));

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useMemo: <A>(factory: () => A) => factory(),
    useSyncExternalStore: (
      subscribe: (listener: () => void) => () => void,
      getSnapshot: () => boolean,
    ) => {
      store.subscribe = subscribe;
      store.getSnapshot = getSnapshot;
      return getSnapshot();
    },
  };
});

let page: EventTarget & { visibilityState: string };
const START = Date.parse("2026-01-01T00:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", { setTimeout, clearTimeout });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useClockReached", () => {
  it("notifies once when the deadline passes, with one timer instead of a ticking clock", () => {
    expect(useClockReached(START + 70 * 60_000)).toBe(false);
    const listener = vi.fn();
    const cleanup = store.subscribe!(listener);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(70 * 60_000 - 1);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot!()).toBe(true);
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-checks when a hidden page returns after the deadline", () => {
    useClockReached(START + 60_000);
    const listener = vi.fn();
    store.subscribe!(listener);
    vi.setSystemTime(START + 120_000);
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stays idle without a deadline", () => {
    expect(useClockReached(null)).toBe(false);
    store.subscribe!(vi.fn());
    expect(vi.getTimerCount()).toBe(0);
  });
});
