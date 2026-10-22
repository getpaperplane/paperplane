import type { LiveVoiceRecognizer, VoiceTranscriber } from "@rove-code/client-runtime/voice-input";

/** Transcribes a finished recording. Only iOS has one. */
export function getLocalVoiceTranscriber(): VoiceTranscriber | null {
  return null;
}

/** Listens live through the platform recognizer. Only Android has one. */
export function getLiveVoiceRecognizer(): LiveVoiceRecognizer | null {
  return null;
}
