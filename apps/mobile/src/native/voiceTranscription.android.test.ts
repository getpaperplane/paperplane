import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  LiveVoiceInputController,
  resetLiveVoiceInputGlobalsForTests,
} from "../../../../packages/client-runtime/src/voice-input/liveController";

type Listener = (event?: unknown) => void;
const native = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event?: unknown) => void>>();
  return {
    listeners,
    start: vi.fn(),
    stop: vi.fn(),
    abort: vi.fn(),
    isRecognitionAvailable: vi.fn(() => true),
    requestPermissionsAsync: vi.fn(async () => ({ granted: true, canAskAgain: true })),
    addListener: vi.fn((name: string, listener: (event?: unknown) => void) => {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return { remove: () => set.delete(listener) };
    }),
  };
});
vi.mock("expo-speech-recognition", () => ({ ExpoSpeechRecognitionModule: native }));

import { getLiveVoiceRecognizer } from "./voiceTranscription.android";

const emit = (name: string, event?: unknown) =>
  [...(native.listeners.get(name) ?? [])].forEach((listener: Listener) => listener(event));
const result = (transcript: string, isFinal: boolean) =>
  emit("result", { isFinal, results: [{ transcript }] });
const listenerCount = () => [...native.listeners.values()].reduce((n, set) => n + set.size, 0);

function controller(commit = vi.fn()) {
  return {
    commit,
    controller: new LiveVoiceInputController({
      getRecognizer: getLiveVoiceRecognizer,
      readDraft: () => ({
        ownerKey: "a",
        text: "hi",
        selection: { start: 2, end: 2 },
        revision: 0,
      }),
      commitDraft: commit,
      onStateChange: () => {},
    }),
  };
}

describe("Android live recognizer", () => {
  beforeEach(() => {
    resetLiveVoiceInputGlobalsForTests();
    native.listeners.clear();
    vi.clearAllMocks();
    native.isRecognitionAvailable.mockReturnValue(true);
  });
  afterEach(() => vi.useRealTimers());

  it("is unavailable when the device has no recognition service", () => {
    native.isRecognitionAvailable.mockReturnValue(false);
    expect(getLiveVoiceRecognizer()).toBeNull();
  });

  it("discards results that arrive after cancel and releases listeners on end", async () => {
    const { controller: c, commit } = controller();
    await c.start();
    result("partial", false);
    c.cancel();
    expect(native.abort).toHaveBeenCalledOnce();
    result("late words", true);
    emit("error", { error: "aborted" });
    emit("end");
    expect(commit).not.toHaveBeenCalled();
    expect(c.currentState.phase).toBe("idle");
    expect(listenerCount()).toBe(0);
  });

  it("holds a restart until the cancelled engine reports end", async () => {
    const { controller: c } = controller();
    await c.start();
    c.cancel();
    const restarting = c.start();
    await Promise.resolve();
    expect(native.start).toHaveBeenCalledTimes(1);
    emit("end");
    await restarting;
    expect(native.start).toHaveBeenCalledTimes(2);
    expect(c.currentState.phase).toBe("recording");
  });

  it("keeps the microphone claim past any fallback window until the native end event", async () => {
    vi.useFakeTimers();
    const { controller: c } = controller();
    await c.start();
    c.cancel();
    const restarting = c.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(native.abort).toHaveBeenCalledOnce();
    expect(native.start).toHaveBeenCalledTimes(1);
    expect(listenerCount()).toBe(3);
    emit("end");
    await restarting;
    expect(native.start).toHaveBeenCalledTimes(2);
  });

  it("keeps a late final result after stop until the native end event", async () => {
    vi.useFakeTimers();
    const { controller: c, commit } = controller();
    await c.start();
    const stopping = c.stop();
    expect(native.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(c.currentState.phase).toBe("transcribing");
    expect(commit).not.toHaveBeenCalled();
    result("late words", true);
    emit("end");
    await stopping;
    expect(commit).toHaveBeenCalledWith("hi late words", { start: 13, end: 13 });
    expect(listenerCount()).toBe(0);
  });

  it("commits the transcript when stopped, and reports speech timeouts as empty input", async () => {
    const first = controller();
    await first.controller.start();
    result("there", true);
    const stopping = first.controller.stop();
    expect(native.stop).toHaveBeenCalledOnce();
    emit("end");
    await stopping;
    expect(first.commit).toHaveBeenCalledWith("hi there", { start: 8, end: 8 });

    const second = controller();
    await second.controller.start();
    emit("error", { error: "speech-timeout" });
    emit("end");
    await Promise.resolve();
    expect(second.controller.currentState.error).toBe("No speech was detected.");
  });
});
