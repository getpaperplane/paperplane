import {
  LiveVoiceInputController,
  type LiveVoiceInputDependencies,
  type VoiceInputRunner,
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputControllerDependencies,
} from "@getpaperplane/client-runtime/voice-input";

export type VoiceInputTarget = {
  readonly ownerKey: string;
  /** Names the draft being dictated into while its composer is off screen. */
  readonly label?: string;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: VoiceInputControllerDependencies["commitDraft"];
  readonly subscribe: () => () => void;
};

export function createVoiceInputTarget(
  ownerKey: string,
  readText: () => string | null,
  commitDraft: VoiceInputTarget["commitDraft"],
  selection: VoiceDraftSnapshot["selection"],
  subscribeToChanges: (onChange: () => void) => () => void,
): VoiceInputTarget {
  let revision = 0;
  return {
    ownerKey,
    readDraft: () => {
      const text = readText();
      if (text === null) return null;
      return { ownerKey, text, selection, revision };
    },
    commitDraft,
    subscribe: () => {
      let previousText = readText();
      return subscribeToChanges(() => {
        const text = readText();
        if (text !== previousText) {
          previousText = text;
          revision += 1;
        }
      });
    },
  };
}

type TargetHooks = {
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: VoiceInputControllerDependencies["commitDraft"];
  readonly onStateChange: VoiceInputControllerDependencies["onStateChange"];
};

/** Binds one controller to the draft it is dictating into, whichever capture it uses. */
export class VoiceInputTargetSession<C extends VoiceInputRunner> {
  readonly controller: C;
  private target: VoiceInputTarget | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    createController: (hooks: TargetHooks) => C,
    onStateChange: VoiceInputControllerDependencies["onStateChange"],
  ) {
    this.controller = createController({
      readDraft: () => this.target?.readDraft() ?? null,
      commitDraft: (text, selection) => this.target?.commitDraft(text, selection),
      onStateChange: (state) => {
        if (!voiceInputBlocksSubmission(state)) {
          this.unsubscribe?.();
          this.unsubscribe = null;
        }
        onStateChange(state);
      },
    });
  }

  get ownerKey(): string | null {
    return this.target?.ownerKey ?? null;
  }

  get label(): string | null {
    return this.target?.label ?? null;
  }

  cancel(ownerKey: string | null): void {
    if (ownerKey !== null && this.ownerKey === ownerKey) this.controller.cancel();
  }

  retry(): Promise<void> {
    return this.target ? this.start(this.target) : Promise.resolve();
  }

  start(target: VoiceInputTarget): Promise<void> {
    if (voiceInputBlocksSubmission(this.controller.currentState)) return Promise.resolve();
    this.target = target;
    this.unsubscribe = target.subscribe();
    return this.controller.start();
  }
}

export class VoiceInputSession extends VoiceInputTargetSession<VoiceInputController> {
  constructor(dependencies: Omit<VoiceInputControllerDependencies, "readDraft" | "commitDraft">) {
    super(
      (hooks) => new VoiceInputController({ ...dependencies, ...hooks }),
      dependencies.onStateChange,
    );
  }
}

export class LiveVoiceInputSession extends VoiceInputTargetSession<LiveVoiceInputController> {
  constructor(dependencies: Omit<LiveVoiceInputDependencies, "readDraft" | "commitDraft">) {
    super(
      (hooks) => new LiveVoiceInputController({ ...dependencies, ...hooks }),
      dependencies.onStateChange,
    );
  }
}
