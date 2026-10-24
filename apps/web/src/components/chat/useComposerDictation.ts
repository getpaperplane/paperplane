import { useEffect, useMemo, useRef, useState } from "react";
import {
  LiveVoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@getpaperplane/client-runtime/voice-input";

import { ensureLocalApi } from "../../localApi";
import {
  createWebVoiceRecognizer,
  isWebVoiceRecognitionSupported,
} from "../../lib/webVoiceRecognition";

const IDLE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const PRIVACY_ACK_KEY = "paperplane:web-dictation-privacy-ack";

export const isComposerDictationSupported = isWebVoiceRecognitionSupported;

/**
 * Dictation inserts text into the draft, so it is offered only where the draft accepts
 * custom text. A dictation already running stays stoppable; if the question changes
 * underneath it, the commit is rejected and reported instead of dropped.
 */
export function isComposerDictationOffered(input: {
  readonly canOperateThread: boolean;
  readonly customAnswerAllowed: boolean;
  readonly dictationBusy: boolean;
}): boolean {
  return input.canOperateThread && (input.customAnswerAllowed || input.dictationBusy);
}

async function acknowledgePrivacy(): Promise<boolean> {
  try {
    if (window.localStorage.getItem(PRIVACY_ACK_KEY) === "1") return true;
  } catch {}
  const confirmed = await ensureLocalApi().dialogs.confirm(
    "Dictation sends your microphone audio to your browser's speech service (for example Google for Chrome, Apple for Safari) to be transcribed. Paperplane does not receive the audio. Continue?",
  );
  if (!confirmed) return false;
  try {
    window.localStorage.setItem(PRIVACY_ACK_KEY, "1");
  } catch {}
  return true;
}

/**
 * Dictates into the composer draft with the browser's speech recognition. It
 * only inserts text at the selection captured when dictation started; it never sends.
 */
export function useComposerDictation(input: {
  readonly ownerKey: string;
  readonly readDraft: () => { text: string; selection: { start: number; end: number } } | null;
  /** Returns `false` when the draft rejected the text. */
  readonly commit: (text: string, cursor: number) => boolean;
}) {
  const latest = useRef(input);
  latest.current = input;
  const [state, setState] = useState<VoiceInputState>(IDLE);
  // A controller is bound to one draft; a different draft gets a new one.
  const ownerKey = input.ownerKey;
  const controller = useMemo(
    () =>
      new LiveVoiceInputController({
        getRecognizer: createWebVoiceRecognizer,
        readDraft: () => {
          const current = latest.current;
          if (current.ownerKey !== ownerKey) return null;
          const draft = current.readDraft();
          // Text equality guards staleness; this controller has no separate revision.
          return draft ? { ownerKey, ...draft, revision: 0 } : null;
        },
        commitDraft: (text, selection) => latest.current.commit(text, selection.start),
        onStateChange: setState,
      }),
    [ownerKey],
  );

  useEffect(() => () => controller.dispose(), [controller]);

  return {
    state,
    isBusy: voiceInputBlocksSubmission(state),
    start: async () => {
      if (!(await acknowledgePrivacy())) return;
      await controller.start();
    },
    stop: () => controller.stop(),
    cancel: () => controller.cancel(),
  };
}
