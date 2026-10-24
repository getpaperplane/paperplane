/**
 * Replay at the SDK session boundary used by PiRuntimeProcess/LazyPiRuntime.
 * Only the worker-backed PiSessionLike is fake: the shipping PiAdapterV2,
 * orchestrator, persistence, and checkpoints run unchanged. No Pi CLI, model,
 * extension, subprocess, or live agent directory is opened.
 *
 * These deterministic transcripts preserve the original RPC scenarios' prompts
 * and SDK event semantics, not their transport framing. State records model the
 * worker's mirrored branch/stats; replies settle async SDK methods. In particular
 * agent_end is not settlement. Calls must match in order (including resume,
 * steering, abort, tree navigation, and disposal); <any> masks generated inputs.
 * The real IPC transport/worker is separately covered by the SDK integration test.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, type ProviderReplayTranscript } from "@getpaperplane/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as PlatformError from "effect/PlatformError";
import type { ProviderAdapterV2Error } from "@getpaperplane/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@getpaperplane/provider-core/server/IdAllocator";
import { ServerConfig } from "../../config.ts";
import * as PiExtensionStatuses from "../../provider/PiExtensionStatuses.ts";
import type {
  PiCreateSessionInput,
  PiSessionEntryLike,
  PiSessionEventLike,
  PiSessionLike,
} from "../../provider/Layers/PiAdapter.ts";
import type { PiSessionState } from "../../provider/Layers/PiRuntimeProtocol.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import { makePiAdapterV2, PI_PROVIDER } from "./PiAdapterV2.ts";

const Usage = Schema.Struct({
  input: Schema.optionalKey(Schema.Number),
  output: Schema.optionalKey(Schema.Number),
  cacheRead: Schema.optionalKey(Schema.Number),
  cacheWrite: Schema.optionalKey(Schema.Number),
});
const Entry = Schema.Struct({
  id: Schema.String,
  parentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  type: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(
    Schema.Struct({
      role: Schema.optionalKey(Schema.String),
      content: Schema.optionalKey(Schema.Json),
      usage: Schema.optionalKey(Usage),
    }),
  ),
});
const State = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  sessionFile: Schema.optional(Schema.String),
  isStreaming: Schema.optional(Schema.Boolean),
  autoCompactionEnabled: Schema.optional(Schema.Boolean),
  thinkingLevel: Schema.optional(Schema.String),
  model: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      provider: Schema.String,
      input: Schema.Array(Schema.String),
    }),
  ),
  stats: Schema.optional(
    Schema.Struct({
      contextUsage: Schema.Struct({
        tokens: Schema.NullOr(Schema.Number),
        contextWindow: Schema.Number,
        percent: Schema.NullOr(Schema.Number),
      }),
    }),
  ),
  leafId: Schema.optional(Schema.String),
});
const Inbound = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("state"),
    key: Schema.Number,
    state: State,
    branch: Schema.optional(Schema.Array(Entry)),
  }),
  Schema.Struct({
    type: Schema.Literal("event"),
    key: Schema.Number,
    event: Schema.Record(Schema.String, Schema.Json),
  }),
  Schema.Struct({
    type: Schema.Literal("reply"),
    key: Schema.Number,
    id: Schema.Number,
    error: Schema.optional(Schema.String),
  }),
]);
const Transcript = Schema.Struct({
  provider: Schema.Literal(PI_PROVIDER),
  protocol: Schema.Literal("pi.sdk-session"),
  version: Schema.Literal("1"),
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(
    Schema.Union([
      Schema.Struct({
        type: Schema.Literal("expect_outbound"),
        label: Schema.optional(Schema.String),
        frame: Schema.Unknown,
      }),
      Schema.Struct({
        type: Schema.Literal("emit_inbound"),
        label: Schema.optional(Schema.String),
        frame: Inbound,
      }),
    ]),
  ),
});
type Transcript = typeof Transcript.Type;

function matches(expected: unknown, actual: unknown): boolean {
  if (expected === "<any>") return true;
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((v, i) => matches(v, actual[i]))
    );
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null) return false;
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].every((key) => matches(Reflect.get(expected, key), Reflect.get(actual, key)));
  }
  return Object.is(expected, actual);
}

class ReplaySession implements PiSessionLike {
  state: Partial<PiSessionState> = {};
  branch: ReadonlyArray<PiSessionEntryLike> = [];
  private readonly listeners = new Set<(event: PiSessionEventLike) => void>();
  private readonly pending = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  private nextId = 0;
  private disposed = false;
  readonly key: number;
  private readonly controller: ReplayController;
  constructor(key: number, controller: ReplayController) {
    this.key = key;
    this.controller = controller;
  }
  get sessionId() {
    return this.state.sessionId ?? "";
  }
  get sessionFile() {
    return this.state.sessionFile;
  }
  get isStreaming() {
    return this.state.isStreaming ?? false;
  }
  get autoCompactionEnabled() {
    return this.state.autoCompactionEnabled;
  }
  get messages() {
    return this.branch.flatMap((entry) => (entry.message ? [entry.message] : []));
  }
  getBranch() {
    return this.branch;
  }
  getEntries() {
    return this.branch;
  }
  getLeafId() {
    return this.state.leafId;
  }
  getModel() {
    return this.state.model;
  }
  getThinkingLevel() {
    return this.state.thinkingLevel ?? "off";
  }
  getSessionStats() {
    return this.state.stats;
  }
  subscribe(listener: (event: PiSessionEventLike) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(event: PiSessionEventLike) {
    for (const listener of this.listeners) listener(event);
  }
  reply(id: number, error?: string) {
    const pending = this.pending.get(id);
    if (!pending) throw new Error(`Unsolicited Pi SDK reply: ${this.key}/${id}`);
    this.pending.delete(id);
    if (error) pending.reject(new Error(error));
    else pending.resolve();
  }
  call(method: string, args: ReadonlyArray<unknown> = []): Promise<void> {
    const id = ++this.nextId;
    const pending = Promise.withResolvers<void>();
    this.pending.set(id, pending);
    this.controller.receive({ method, key: this.key, id, args });
    return pending.promise;
  }
  prompt(...args: Parameters<PiSessionLike["prompt"]>) {
    return this.call("prompt", args);
  }
  followUp(text: string) {
    return this.call("followUp", [text]);
  }
  compact() {
    return this.call("compact");
  }
  abort() {
    return this.call("abort");
  }
  fork(entryId: string | null) {
    return this.call("fork", [entryId]);
  }
  setModel(model: string) {
    return this.call("setModel", [model]);
  }
  setThinkingLevel(level: string) {
    return this.call("setThinkingLevel", [level]);
  }
  dispose() {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    return this.call("dispose");
  }
}

class ReplayController {
  private cursor = 0;
  private failure: Error | undefined;
  private readonly sessions: ReplaySession[] = [];
  private readonly transcript: Transcript;
  constructor(transcript: Transcript) {
    this.transcript = transcript;
  }
  create(input: PiCreateSessionInput): Promise<PiSessionLike> {
    const session = new ReplaySession(this.sessions.length + 1, this);
    this.sessions.push(session);
    this.receive({ method: "createSession", key: session.key, input });
    return Promise.resolve(session);
  }
  receive(actual: unknown): void {
    const entry = this.transcript.entries[this.cursor];
    if (entry?.type !== "expect_outbound" || !matches(entry.frame, actual)) {
      this.failure ??= new Error(
        `Pi SDK replay mismatch in ${this.transcript.scenario} at ${this.cursor}: expected ${JSON.stringify(entry)}, got ${JSON.stringify(actual)}`,
      );
      throw this.failure;
    }
    this.cursor++;
    while (this.transcript.entries[this.cursor]?.type === "emit_inbound") {
      const inbound = this.transcript.entries[this.cursor++]!;
      if (inbound.type !== "emit_inbound") break;
      const frame = inbound.frame;
      const session = this.sessions[frame.key - 1];
      if (!session) throw new Error(`Missing Pi SDK replay session ${frame.key}`);
      switch (frame.type) {
        case "state":
          Object.assign(session.state, frame.state);
          if (frame.branch) session.branch = frame.branch;
          break;
        case "event":
          session.emit({
            ...frame.event,
            type: Schema.decodeUnknownSync(Schema.String)(frame.event.type),
          });
          break;
        case "reply":
          session.reply(frame.id, frame.error);
          break;
      }
    }
  }
  assertComplete(): void {
    if (this.failure) throw this.failure;
    if (this.cursor !== this.transcript.entries.length)
      throw new Error(
        `Pi SDK replay incomplete in ${this.transcript.scenario}: ${this.cursor}/${this.transcript.entries.length}`,
      );
  }
}

export const PiOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  Transcript,
  Schema.SchemaError | PlatformError.PlatformError | ProviderAdapterV2Error
> = {
  driver: PI_PROVIDER,
  decodeTranscript: (transcript: ProviderReplayTranscript) =>
    Schema.decodeUnknownEffect(Transcript)(transcript),
  makeProviderAdapterRegistryLayer: (transcript) =>
    Layer.effect(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      Effect.gen(function* () {
        const controller = new ReplayController(transcript);
        yield* Effect.addFinalizer(() => Effect.sync(() => controller.assertComplete()));
        const instanceId = ProviderInstanceId.make("pi");
        const adapter = yield* makePiAdapterV2({
          instanceId,
          createSession: (input) => controller.create(input),
        });
        const capabilities = yield* adapter.getCapabilities();
        return ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
          get: () => Effect.succeed(adapter),
          list: () => Effect.succeed([instanceId]),
          getMetadata: () =>
            Effect.succeed({
              driver: PI_PROVIDER,
              continuationKey: "pi-sdk-replay",
              enabled: true,
              capabilities,
            }),
        });
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          PiExtensionStatuses.layer,
          ServerConfig.layerTest(process.cwd(), { prefix: "paperplane-pi-sdk-replay-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
};
