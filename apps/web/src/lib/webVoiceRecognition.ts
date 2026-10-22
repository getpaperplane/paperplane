import type {
  LiveVoiceErrorCode,
  LiveVoiceRecognizer,
} from "@rove-code/client-runtime/voice-input";

// lib.dom does not ship the Web Speech API recognition types.
type SpeechRecognitionResultLike = {
  readonly isFinal: boolean;
  readonly 0?: { readonly transcript: string };
};
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult:
    | ((event: { resultIndex: number; results: ArrayLike<SpeechRecognitionResultLike> }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function recognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  // Electron ships Chromium without Google's speech service keys, so recognition
  // there fails with a network error. Treat the desktop shell as unsupported.
  if (window.desktopBridge !== undefined) return null;
  const candidate = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
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
      recognition.onresult = (event) => {
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
      recognition.onerror = (event) => {
        const code = mapError(event.error);
        if (code) events.onError(code);
      };
      recognition.onend = () => {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        events.onEnd();
      };
      recognition.start();
      return { stop: () => recognition.stop(), abort: () => recognition.abort() };
    },
  };
}
