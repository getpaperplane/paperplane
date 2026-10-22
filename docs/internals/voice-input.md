# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text. iOS records a file and transcribes it on device; Android and browsers listen
live through the platform recognizer; environment-backed transcription is not
implemented.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced.

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results.

## Live recognition (Android, web)

Android's `SpeechRecognizer` and the browser's `SpeechRecognition` own the
microphone and produce no file, so they cannot be a `VoiceTranscriber`. The
[live controller](../../packages/client-runtime/src/voice-input/liveController.ts)
reuses `resolveTranscriptCommit` for draft ownership and staleness, but its
cancellation rule is the same one stated above, applied to the engine: cancel
invalidates results immediately, and a module-level claim on the microphone is held
until the recognizer reports `onEnd`, so a restart cannot overlap a stopping
engine. Adapters must call `onEnd` exactly once, only when the native engine has
actually stopped; no adapter may release the claim on a timer. A `commitDraft`
that returns `false` surfaces an error instead of dropping the transcript. Android uses `expo-speech-recognition`, autolinked on Android only. The
web adapter is hidden in Electron, whose Chromium has no speech backend, and in
browsers without the API.
