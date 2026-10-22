import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createWebVoiceRecognizer, isWebVoiceRecognitionSupported } from "./webVoiceRecognition";

class FakeRecognition {
  static instance: FakeRecognition | null = null;
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onresult: ((event: never) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  constructor() {
    FakeRecognition.instance = this;
  }
}

function stubWindow(extra: Record<string, unknown>) {
  vi.stubGlobal("window", extra);
  vi.stubGlobal("navigator", { language: "en-US" });
}

describe("web voice recognition", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is unavailable without the API and inside the desktop shell", () => {
    stubWindow({});
    expect(isWebVoiceRecognitionSupported()).toBe(false);
    stubWindow({ webkitSpeechRecognition: FakeRecognition, desktopBridge: {} });
    expect(createWebVoiceRecognizer()).toBeNull();
  });

  it("maps results, drops the aborted error, and reports end once", () => {
    stubWindow({ webkitSpeechRecognition: FakeRecognition });
    const recognizer = createWebVoiceRecognizer()!;
    const events = { onResult: vi.fn(), onError: vi.fn(), onEnd: vi.fn() };
    const recognition = recognizer.start(events);
    const fake = FakeRecognition.instance!;
    expect(fake.start).toHaveBeenCalledOnce();

    fake.onresult?.({
      resultIndex: 0,
      results: [
        { isFinal: true, 0: { transcript: "hello" } },
        { isFinal: false, 0: { transcript: " wor" } },
      ],
    } as never);
    expect(events.onResult).toHaveBeenNthCalledWith(1, "hello", true);
    expect(events.onResult).toHaveBeenNthCalledWith(2, " wor", false);

    recognition.abort();
    fake.onerror?.({ error: "aborted" });
    expect(events.onError).not.toHaveBeenCalled();
    fake.onerror?.({ error: "not-allowed" });
    expect(events.onError).toHaveBeenCalledWith("not-allowed");
    fake.onend?.();
    expect(events.onEnd).toHaveBeenCalledOnce();
    expect(fake.onend).toBeNull();
  });
});
