import type {
  LiveVoiceErrorCode,
  LiveVoiceRecognizer,
} from "@getpaperplane/client-runtime/voice-input";

// lib.dom does not ship the Web Speech API recognition types.
type SpeechRecognitionResultLike = {
  readonly isFinal: boolean;
  readonly 0?: { readonly transcript: string };
};
type SpeechRecognitionResultEventLike = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
};
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

/** Web Speech events are not in lib.dom, so read their fields by shape. */
function readResultEvent(event: Event): SpeechRecognitionResultEventLike {
  // SAFETY: "result" events are SpeechRecognitionEvent; absent fields fall back below.
  const { resultIndex, results } = event as Event & Partial<SpeechRecognitionResultEventLike>;
  return { resultIndex: resultIndex ?? 0, results: results ?? [] };
}

function readErrorName(event: Event): string {
  // SAFETY: "error" events are SpeechRecognitionErrorEvent; absent fields fall back.
  return (event as Event & { error?: string }).error ?? "unknown";
}

function recognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  // Electron ships Chromium without Google's speech service keys, so recognition
  // there fails with a network error. Treat the desktop shell as unsupported.
  if (window.desktopBridge !== undefined) return null;
  // lib.dom has no recognition globals, so read them by name.
  const candidate: Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  } = window;
  return candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition ?? null;
}

export function isWebVoiceRecognitionSupported(): boolean {
  return recognitionConstructor() !== null;
}

function mapError(error: string): LiveVoiceErrorCode | null {
  switch (error) {
    case "aborted":
      return null;
    case "no-speech":
      return "no-speech";
    case "not-allowed":
    case "service-not-allowed":
      return "not-allowed";
    case "language-not-supported":
      return "unsupported-locale";
    case "network":
      return "network";
    default:
      return "failed";
  }
}

/**
 * Dictation through the browser's SpeechRecognition. Chromium sends the audio to
 * the browser vendor's speech service, so callers must disclose that first.
 * Returns null where the API is missing or cannot work (the desktop shell).
 */
export function createWebVoiceRecognizer(): LiveVoiceRecognizer | null {
  const Recognition = recognitionConstructor();
  if (!Recognition) return null;
  const locale = navigator.language || "en-US";
  return {
    locale,
    // The browser prompts for the microphone when recognition starts, and reports
    // a denial as a `not-allowed` error.
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    start: (events) => {
      const recognition = new Recognition();
      recognition.lang = locale;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      const onResult = (domEvent: Event) => {
        const event = readResultEvent(domEvent);
        let finalText = "";
        let interimText = "";
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const transcript = result?.[0]?.transcript ?? "";
          if (result?.isFinal) finalText += transcript;
          else interimText += transcript;
        }
        if (finalText) events.onResult(finalText, true);
        if (interimText) events.onResult(interimText, false);
      };
      const onError = (domEvent: Event) => {
        const code = mapError(readErrorName(domEvent));
        if (code) events.onError(code);
      };
      const onEnd = () => {
        recognition.removeEventListener("result", onResult);
        recognition.removeEventListener("error", onError);
        recognition.removeEventListener("end", onEnd);
        events.onEnd();
      };
      recognition.addEventListener("result", onResult);
      recognition.addEventListener("error", onError);
      recognition.addEventListener("end", onEnd);
      recognition.start();
      return { stop: () => recognition.stop(), abort: () => recognition.abort() };
    },
  };
}
