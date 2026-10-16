import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { pollWhileVisible } from "./useDesktopLocalBootstraps";

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";

  setVisibility(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

describe("pollWhileVisible", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops reading while hidden and reads immediately when shown again", () => {
    const doc = new FakeDocument();
    const read = vi.fn();
    const stop = pollWhileVisible(read, 1_000, doc);
    expect(read).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    expect(read).toHaveBeenCalledTimes(3);

    doc.setVisibility("hidden");
    vi.advanceTimersByTime(10_000);
    expect(read).toHaveBeenCalledTimes(3);

    doc.setVisibility("visible");
    expect(read).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(1_000);
    expect(read).toHaveBeenCalledTimes(5);

    stop();
    doc.setVisibility("visible");
    vi.advanceTimersByTime(10_000);
    expect(read).toHaveBeenCalledTimes(5);
  });

  it("does not read when it starts hidden", () => {
    const doc = new FakeDocument();
    doc.visibilityState = "hidden";
    const read = vi.fn();
    pollWhileVisible(read, 1_000, doc);
    vi.advanceTimersByTime(5_000);
    expect(read).not.toHaveBeenCalled();
  });
});
