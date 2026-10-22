import {
  resolveTranscriptCommit,
  VOICE_RECORDING_LIMIT_SECONDS,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "./controller.ts";

/**
 * Live speech recognition that owns its own microphone (Android SpeechRecognizer,
 * browser SpeechRecognition). It has no audio file to hand to a `VoiceTranscriber`,
 * so it gets its own controller. Draft ownership and staleness reuse the
 * recorded controller's `resolveTranscriptCommit`.
 */
export type LiveVoiceErrorCode =
  | "not-allowed"
  | "no-speech"
  | "unsupported-locale"
  | "network"
  | "unavailable"
  | "failed";

export type LiveVoiceRecognitionEvents = {
  /** Text recognized so far. Interim text is replaced by the next result. */
  readonly onResult: (text: string, isFinal: boolean) => void;
  readonly onError: (code: LiveVoiceErrorCode) => void;
  /** Fires exactly once, after the engine has stopped and released the microphone. */
  readonly onEnd: () => void;
};

export type LiveVoiceRecognition = {
  /** Finish listening. A final result may still arrive before `onEnd`. */
  readonly stop: () => void;
  /** Discard. Results delivered before `onEnd` are ignored by the controller. */
  readonly abort: () => void;
};

export type LiveVoiceRecognizer = {
  readonly locale: string;
  readonly requestPermission: () => Promise<{
    readonly granted: boolean;
    readonly canAskAgain: boolean;
  }>;
  /** May throw synchronously when the engine cannot start. */
  readonly start: (events: LiveVoiceRecognitionEvents) => LiveVoiceRecognition;
};

export type LiveVoiceInputDependencies = {
  readonly getRecognizer: () => LiveVoiceRecognizer | null;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
  readonly onStateChange: (state: VoiceInputState) => void;
};

/** The surface clients drive, shared by recorded and live controllers. */
export interface VoiceInputRunner {
  readonly currentState: VoiceInputState;
  start(): Promise<void>;
  stop(): Promise<void>;
  cancel(): void;
  appMovedToBackground(): Promise<void> | void;
  ownerChanged(): void;
  dispose(): void;
}

type LiveRun = {
  readonly token: number;
  readonly recognizer: LiveVoiceRecognizer;
  readonly draft: VoiceDraftSnapshot;
  readonly ended: Promise<void>;
  readonly markEnded: () => void;
  recognition: LiveVoiceRecognition | null;
  committed: string;
  interim: string;
  error: LiveVoiceErrorCode | null;
  endedAlready: boolean;
  limitTimer: ReturnType<typeof setTimeout> | null;
};

/** Only one engine owns the microphone. A cancelled run holds it until `onEnd`. */
let activeEngine: Promise<void> | null = null;

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

function errorState(code: LiveVoiceErrorCode): VoiceInputState {
  switch (code) {
    case "not-allowed":
      return {
        phase: "error",
        error: "Microphone or speech recognition access is required for voice input.",
        errorAction: "settings",
      };
    case "no-speech":
      return { phase: "error", error: "No speech was detected.", errorAction: "retry" };
    case "unsupported-locale":
      return {
        phase: "error",
        error: "Voice transcription is not available for this language.",
        errorAction: null,
      };
    case "network":
      return {
        phase: "error",
        error: "Speech recognition needs a network connection.",
        errorAction: "retry",
      };
    case "unavailable":
      return {
        phase: "error",
        error: "Voice transcription is not available.",
        errorAction: null,
      };
    case "failed":
      return { phase: "error", error: "Could not transcribe your speech.", errorAction: "retry" };
  }
}

export class LiveVoiceInputController implements VoiceInputRunner {
  private state: VoiceInputState = IDLE_STATE;
  private operationToken = 0;
  private run: LiveRun | null = null;

  constructor(private readonly dependencies: LiveVoiceInputDependencies) {}

  get currentState(): VoiceInputState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state.phase !== "idle" && this.state.phase !== "error") return;
    const initiating = this.dependencies.readDraft();
    if (!initiating) {
      this.setState({
        phase: "error",
        error: "This draft is no longer available.",
        errorAction: "retry",
      });
      return;
    }
    const recognizer = this.dependencies.getRecognizer();
    if (!recognizer) {
      this.setState(errorState("unavailable"));
      return;
    }
    const token = ++this.operationToken;
    this.setState({ phase: "preparing", error: null, errorAction: null });

    try {
      while (activeEngine) {
        await activeEngine;
        if (token !== this.operationToken) return;
      }
      const permission = await recognizer.requestPermission();
      if (token !== this.operationToken) return;
      if (!permission.granted) {
        this.setState({
          ...errorState("not-allowed"),
          errorAction: permission.canAskAgain ? "retry" : "settings",
        });
        return;
      }
      if (activeEngine) {
        // Another controller started while permission was pending.
        this.setState({
          phase: "error",
          error: "Another voice recording is already active.",
          errorAction: "retry",
        });
        return;
      }
      const draft = this.dependencies.readDraft();
      if (!draft || draft.ownerKey !== initiating.ownerKey) {
        this.setState({
          phase: "error",
          error: "This draft is no longer available.",
          errorAction: "retry",
        });
        return;
      }

      let markEnded!: () => void;
      const ended = new Promise<void>((r) => (markEnded = r));
      const run: LiveRun = {
        token,
        recognizer,
        draft,
        ended,
        markEnded,
        recognition: null,
        committed: "",
        interim: "",
        error: null,
        endedAlready: false,
        limitTimer: null,
      };
      this.run = run;
      activeEngine = ended.then(() => {
        activeEngine = null;
      });
      try {
        run.recognition = recognizer.start({
          onResult: (text, isFinal) => this.handleResult(run, text, isFinal),
          onError: (code) => this.handleError(run, code),
          onEnd: () => this.handleEnd(run),
        });
      } catch {
        run.endedAlready = true;
        markEnded();
        this.run = null;
        this.setState(errorState("failed"));
        return;
      }
      if (token !== this.operationToken) {
        // Cancelled while the engine was starting.
        run.recognition.abort();
        return;
      }
      run.limitTimer = setTimeout(() => void this.stop(), VOICE_RECORDING_LIMIT_SECONDS * 1_000);
      this.setState({ phase: "recording", error: null, errorAction: null });
    } catch {
      if (token === this.operationToken) {
        this.setState({
          phase: "error",
          error: "Could not start voice recording.",
          errorAction: "retry",
        });
      }
    }
  }

  async stop(): Promise<void> {
    const run = this.run;
    if (this.state.phase !== "recording" || !run) return;
    this.clearLimit(run);
    this.setState({ phase: "transcribing", error: null, errorAction: null });
    run.recognition?.stop();
    await run.ended;
    await this.finish(run);
  }

  cancel(): void {
    switch (this.state.phase) {
      case "idle":
        return;
      case "error":
        this.setState(IDLE_STATE);
        return;
      default:
        this.discard(null);
    }
  }

  appMovedToBackground(): void {
    if (this.state.phase !== "recording" && this.state.phase !== "preparing") return;
    this.discard("Voice input stopped when the app moved to the background.");
  }

  ownerChanged(): void {
    if (this.state.phase !== "idle") this.cancel();
  }

  dispose(): void {
    if (this.state.phase !== "idle") this.discard(null);
  }

  /** Invalidates the run now; the engine stays owned until it reports `onEnd`. */
  private discard(error: string | null): void {
    this.operationToken += 1;
    const run = this.run;
    this.run = null;
    if (run) {
      this.clearLimit(run);
      if (!run.endedAlready) run.recognition?.abort();
    }
    this.setState(error ? { phase: "error", error, errorAction: "retry" } : IDLE_STATE);
  }

  private async finish(run: LiveRun): Promise<void> {
    if (this.run !== run || run.token !== this.operationToken) return;
    this.run = null;
    if (run.error && run.error !== "no-speech") {
      this.setState(errorState(run.error));
      return;
    }
    const transcript = [run.committed, run.interim].filter(Boolean).join(" ");
    if (transcript.trim().length === 0) {
      this.setState(errorState("no-speech"));
      return;
    }
    const result = resolveTranscriptCommit(
      run.draft,
      this.dependencies.readDraft(),
      transcript,
      run.recognizer.locale,
    );
    if (result.kind === "stale") {
      this.setState({
        phase: "error",
        error: "The draft changed while voice input was running. The transcript was not added.",
        errorAction: "retry",
      });
      return;
    }
    if (result.kind === "empty") {
      this.setState(errorState("no-speech"));
      return;
    }
    this.dependencies.commitDraft(result.text, result.selection);
    this.setState(IDLE_STATE);
  }

  private handleResult(run: LiveRun, text: string, isFinal: boolean): void {
    if (run.token !== this.operationToken) return;
    if (isFinal) {
      run.committed = [run.committed, text.trim()].filter(Boolean).join(" ");
      run.interim = "";
    } else {
      run.interim = text.trim();
    }
  }

  private handleError(run: LiveRun, code: LiveVoiceErrorCode): void {
    if (run.token !== this.operationToken) return;
    run.error = code;
    if (this.state.phase === "recording") {
      // The engine gave up on its own. Its `onEnd` finishes the run.
      this.clearLimit(run);
      this.setState({ phase: "transcribing", error: null, errorAction: null });
    }
  }

  private handleEnd(run: LiveRun): void {
    run.endedAlready = true;
    run.markEnded();
    // The engine stopped by itself (silence timeout or a final result) while recording.
    if (this.state.phase === "recording" && this.run === run) {
      this.clearLimit(run);
      this.setState({ phase: "transcribing", error: null, errorAction: null });
      void this.finish(run);
      return;
    }
    // An error moved us to `transcribing` without a stop() waiting on the engine.
    if (this.state.phase === "transcribing" && this.run === run && run.error) {
      void this.finish(run);
    }
  }

  private clearLimit(run: LiveRun): void {
    if (run.limitTimer) clearTimeout(run.limitTimer);
    run.limitTimer = null;
  }

  private setState(state: VoiceInputState): void {
    this.state = state;
    this.dependencies.onStateChange(state);
  }
}

export function resetLiveVoiceInputGlobalsForTests(): void {
  activeEngine = null;
}
