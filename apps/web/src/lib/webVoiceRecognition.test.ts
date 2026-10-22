import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createWebVoiceRecognizer, isWebVoiceRecognitionSupported } from "./webVoiceRecognition";

class FakeRecognition extends EventTarget {
  static instance: FakeRecognition | null = null;
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  constructor() {
    super();
    FakeRecognition.instance = this;
  }
  emit(type: string, detail: Record<string, number | string | unknown[]> = {}) {
    this.dispatchEvent(Object.assign(new Event(type), detail));
  }
}

function stubWindow(extra: {
  desktopBridge?: string;
  webkitSpeechRecognition?: typeof FakeRecognition;
}) {
  vi.stubGlobal("window", extra);
  vi.stubGlobal("navigator", { language: "en-US" });
}

describe("web voice recognition", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is unavailable without the API and inside the desktop shell", () => {
    stubWindow({});
    expect(isWebVoiceRecognitionSupported()).toBe(false);
    stubWindow({ webkitSpeechRecognition: FakeRecognition, desktopBridge: "yes" });
    expect(createWebVoiceRecognizer()).toBeNull();
  });

  it("maps results, drops the aborted error, and reports end once", () => {
    stubWindow({ webkitSpeechRecognition: FakeRecognition });
    const recognizer = createWebVoiceRecognizer()!;
    const events = { onResult: vi.fn(), onError: vi.fn(), onEnd: vi.fn() };
    const recognition = recognizer.start(events);
    const fake = FakeRecognition.instance!;
    expect(fake.start).toHaveBeenCalledOnce();

    fake.emit("result", {
      resultIndex: 0,
      results: [
        { isFinal: true, 0: { transcript: "hello" } },
        { isFinal: false, 0: { transcript: " wor" } },
      ],
    });
    expect(events.onResult).toHaveBeenNthCalledWith(1, "hello", true);
    expect(events.onResult).toHaveBeenNthCalledWith(2, " wor", false);

    recognition.abort();
    fake.emit("error", { error: "aborted" });
    expect(events.onError).not.toHaveBeenCalled();
    fake.emit("error", { error: "not-allowed" });
    expect(events.onError).toHaveBeenCalledWith("not-allowed");
    fake.emit("end");
    fake.emit("result", {
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: "late" } }],
    });
    fake.emit("end");
    expect(events.onEnd).toHaveBeenCalledOnce();
    expect(events.onResult).toHaveBeenCalledTimes(2);
  });
});
