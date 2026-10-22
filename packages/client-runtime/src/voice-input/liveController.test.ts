import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { VoiceDraftSnapshot } from "./controller.ts";
import {
  LiveVoiceInputController,
  resetLiveVoiceInputGlobalsForTests,
  type LiveVoiceRecognitionEvents,
  type LiveVoiceRecognizer,
} from "./liveController.ts";

function setup(options?: { granted?: boolean; canAskAgain?: boolean }) {
  let events!: LiveVoiceRecognitionEvents;
  const engine = { stop: vi.fn(), abort: vi.fn() };
  const start = vi.fn((next: LiveVoiceRecognitionEvents) => {
    events = next;
    return engine;
  });
  const recognizer: LiveVoiceRecognizer = {
    locale: "en-US",
    requestPermission: async () => ({
      granted: options?.granted ?? true,
      canAskAgain: options?.canAskAgain ?? true,
    }),
    start,
  };
  let draft: VoiceDraftSnapshot = {
    ownerKey: "a",
    text: "hello",
    selection: { start: 5, end: 5 },
    revision: 0,
  };
  const commitDraft = vi.fn();
  const controller = new LiveVoiceInputController({
    getRecognizer: () => recognizer,
    readDraft: () => draft,
    commitDraft,
    onStateChange: () => {},
  });
  return {
    controller,
    commitDraft,
    engine,
    start,
    events: () => events,
    editDraft: () => (draft = { ...draft, text: "hello!", revision: 1 }),
  };
}

describe("LiveVoiceInputController", () => {
  beforeEach(() => resetLiveVoiceInputGlobalsForTests());

  it("inserts the final transcript once the engine has stopped", async () => {
    const t = setup();
    await t.controller.start();
    expect(t.controller.currentState.phase).toBe("recording");
    t.events().onResult("wor", false);
    const stopping = t.controller.stop();
    t.events().onResult("world", true);
    expect(t.commitDraft).not.toHaveBeenCalled();
    t.events().onEnd();
    await stopping;
    expect(t.commitDraft).toHaveBeenCalledWith("hello world", { start: 11, end: 11 });
    expect(t.controller.currentState.phase).toBe("idle");
  });

  it("keeps interim text when the engine ends without a final result", async () => {
    const t = setup();
    await t.controller.start();
    t.events().onResult("spoken", false);
    const stopping = t.controller.stop();
    t.events().onEnd();
    await stopping;
    expect(t.commitDraft).toHaveBeenCalledWith("hello spoken", { start: 12, end: 12 });
  });

  it("ignores late results after cancel and holds the microphone until the engine ends", async () => {
    const t = setup();
    await t.controller.start();
    const first = t.events();
    t.controller.cancel();
    expect(t.engine.abort).toHaveBeenCalledOnce();
    first.onResult("late", true);

    const restarting = t.controller.start();
    await Promise.resolve();
    expect(t.start).toHaveBeenCalledTimes(1);
    first.onEnd();
    await restarting;
    expect(t.start).toHaveBeenCalledTimes(2);
    expect(t.commitDraft).not.toHaveBeenCalled();
    expect(t.controller.currentState.phase).toBe("recording");
  });

  it("does not insert into a draft edited while listening", async () => {
    const t = setup();
    await t.controller.start();
    t.events().onResult("world", true);
    t.editDraft();
    const stopping = t.controller.stop();
    t.events().onEnd();
    await stopping;
    expect(t.commitDraft).not.toHaveBeenCalled();
    expect(t.controller.currentState.error).toContain("draft changed");
  });

  it("reports empty input", async () => {
    const t = setup();
    await t.controller.start();
    const stopping = t.controller.stop();
    t.events().onEnd();
    await stopping;
    expect(t.controller.currentState).toMatchObject({
      phase: "error",
      error: "No speech was detected.",
    });
  });

  it("finishes when the engine stops by itself", async () => {
    const t = setup();
    await t.controller.start();
    t.events().onResult("done", true);
    t.events().onEnd();
    await Promise.resolve();
    expect(t.commitDraft).toHaveBeenCalledWith("hello done", { start: 10, end: 10 });
  });

  it("surfaces an engine error instead of a partial transcript", async () => {
    const t = setup();
    await t.controller.start();
    t.events().onResult("partial", false);
    t.events().onError("network");
    t.events().onEnd();
    await Promise.resolve();
    expect(t.commitDraft).not.toHaveBeenCalled();
    expect(t.controller.currentState.error).toContain("network");
  });

  it.each([
    { canAskAgain: true, action: "retry" },
    { canAskAgain: false, action: "settings" },
  ])("handles denied permission (canAskAgain=$canAskAgain)", async ({ canAskAgain, action }) => {
    const t = setup({ granted: false, canAskAgain });
    await t.controller.start();
    expect(t.start).not.toHaveBeenCalled();
    expect(t.controller.currentState).toMatchObject({ phase: "error", errorAction: action });
  });
});
