import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";

import type {
  LiveVoiceErrorCode,
  LiveVoiceRecognizer,
  VoiceTranscriber,
} from "@getpaperplane/client-runtime/voice-input";

export function getLocalVoiceTranscriber(): VoiceTranscriber | null {
  return null;
}

function mapError(code: string): LiveVoiceErrorCode | null {
  switch (code) {
    case "aborted":
      return null;
    case "no-speech":
    case "speech-timeout":
      return "no-speech";
    case "not-allowed":
      return "not-allowed";
    case "language-not-supported":
      return "unsupported-locale";
    case "network":
      return "network";
    case "service-not-allowed":
      return "unavailable";
    default:
      return "failed";
  }
}

export function getLiveVoiceRecognizer(): LiveVoiceRecognizer | null {
  if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) return null;
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  return {
    locale,
    requestPermission: async () => {
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      return { granted: permission.granted, canAskAgain: permission.canAskAgain };
    },
    start: (events) => {
      let ended = false;
      const subscriptions = [
        ExpoSpeechRecognitionModule.addListener("result", (event) => {
          const transcript = event.results[0]?.transcript;
          if (transcript) events.onResult(transcript, event.isFinal);
        }),
        ExpoSpeechRecognitionModule.addListener("error", (event) => {
          const code = mapError(event.error);
          if (code) events.onError(code);
        }),
        ExpoSpeechRecognitionModule.addListener("end", () => finish()),
      ];
      const finish = () => {
        if (ended) return;
        ended = true;
        for (const subscription of subscriptions) subscription.remove();
        events.onEnd();
      };
      try {
        ExpoSpeechRecognitionModule.start({
          lang: locale,
          interimResults: true,
          continuous: true,
          addsPunctuation: true,
        });
      } catch (error) {
        for (const subscription of subscriptions) subscription.remove();
        throw error;
      }
      return {
        // Only the native `end` event releases the subscriptions and the microphone claim.
        stop: () => ExpoSpeechRecognitionModule.stop(),
        abort: () => ExpoSpeechRecognitionModule.abort(),
      };
    },
  };
}
