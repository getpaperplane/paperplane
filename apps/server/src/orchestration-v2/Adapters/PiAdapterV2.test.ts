import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as PiExtensionStatuses from "../../provider/PiExtensionStatuses.ts";
import * as IdAllocator from "@getpaperplane/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@getpaperplane/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@getpaperplane/provider-core/server/ProviderAdapter";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@getpaperplane/contracts";
import { ServerConfig } from "../../config.ts";
import { makePiAdapterV2 } from "./PiAdapterV2.ts";
import type {
  PiSessionLike,
  PiSessionEventLike,
  PiSessionEntryLike,
  PiCreateSessionInput,
} from "../../provider/Layers/PiAdapter.ts";
const instanceId = ProviderInstanceId.make("pi");
const threadId = ThreadId.make("pi-v2-test");
const selection = { instanceId, model: "fixture/model" };
const policy = {
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  cwd: "/workspace",
};
const layer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  PiExtensionStatuses.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "paperplane-pi-v2-" }),
).pipe(Layer.provideMerge(NodeServices.layer));
const decodeEvent = Schema.decodeUnknownSync(ProviderAdapter.ProviderAdapterV2Event);
function rawSession(initialBranch: PiSessionEntryLike[] = []) {
  let listener: (event: PiSessionEventLike) => void = () => {};
  let streaming = true;
  let branch = [...initialBranch];
  const prompted = Promise.withResolvers<void>();
  const models: string[] = [];
  const thinkingLevels: string[] = [];
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const abortAcknowledged = Promise.withResolvers<void>();
  const answers: Array<unknown> = [];
  const forks: Array<string | null> = [];
  const session: PiSessionLike = {
    sessionId: "session",
    modelFallbackMessage: "Fixture model fallback",
    sessionFile: "/tmp/fixture_session.jsonl",
    get isStreaming() {
      return streaming;
    },
    messages: [],
    prompt: (text, options) => {
      if (options?.streamingBehavior === "steer") return Promise.resolve();
      if (text !== "/extension") {
        branch.push({
          id: "user",
          parentId: branch.at(-1)?.id ?? null,
          type: "message",
          message: { role: "user" },
        });
        branch.push({
          id: "assistant",
          parentId: "user",
          type: "message",
          message: { role: "assistant" },
        });
      }
      prompted.resolve();
      return pending;
    },
    followUp: async () => {},
    compact: () => {
      branch.push({ id: "compacted", parentId: branch.at(-1)?.id ?? null, type: "compaction" });
      prompted.resolve();
      return pending;
    },
    abort: async () => {
      abortAcknowledged.resolve();
    },
    dispose: () => {
      release();
    },
    setModel: async (model) => {
      models.push(model);
    },
    setThinkingLevel: (level) => {
      thinkingLevels.push(level);
    },
    getModel: () => ({ id: "model", provider: "fixture", input: ["text"] }),
    getThinkingLevel: () => "high",
    subscribe: (callback) => {
      listener = callback;
      return () => {
        listener = () => {};
      };
    },
    respondToUserInput: (native, answer) => {
      answers.push(answer);
      listener({
        type: "paperplane_ui_resolved",
        requestId: native,
        answers: { answer: typeof answer.answer === "string" ? answer.answer : "" },
      });
      return true;
    },
    getBranch: () => branch,
    getLeafId: () => branch.at(-1)?.id,
    getSessionStats: () => ({ contextUsage: { tokens: 12, contextWindow: 64000, percent: 0.01 } }),
    fork: async (entry) => {
      forks.push(entry);
    },
  };
  return {
    session,
    models,
    thinkingLevels,
    prompted: prompted.promise,
    setBranch: (entries: PiSessionEntryLike[]) => {
      branch = entries;
    },
    answers,
    forks,
    abortAcknowledged: abortAcknowledged.promise,
    emit: (event: PiSessionEventLike) => listener(event),
    settle: () => {
      streaming = false;
      listener({ type: "agent_settled" });
      release();
    },
  };
}
function turnInput(
  thread: OrchestrationV2ProviderThread,
  now: DateTime.Utc,
): ProviderAdapter.ProviderAdapterV2TurnInput {
  const runId = RunId.make("run");
  return {
    threadId,
    runId,
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("attempt"),
    rootNodeId: NodeId.make("root"),
    providerThread: thread,
    message: {
      messageId: MessageId.make("user"),
      text: "hello",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection: selection,
    runtimePolicy: policy,
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Pi V2",
      providerInstanceId: instanceId,
      modelSelection: selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: thread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  };
}
const setup = Effect.fn(function* (text = "hello", initialBranch: PiSessionEntryLike[] = []) {
  const raw = rawSession(initialBranch);
  const sessions = [raw];
  const creates: PiCreateSessionInput[] = [];
  const adapter = yield* makePiAdapterV2({
    instanceId,
    createSession: async (input) => {
      creates.push(input);
      if (creates.length > 1) sessions.push(rawSession());
      return sessions.at(-1)!.session;
    },
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("runtime"),
    modelSelection: selection,
    runtimePolicy: policy,
  });
  const thread = yield* runtime.ensureThread({
    threadId,
    modelSelection: selection,
    runtimePolicy: policy,
  });
  const events: ProviderAdapter.ProviderAdapterV2Event[] = [];
  const terminal =
    yield* Deferred.make<
      Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>
    >();
  const question =
    yield* Deferred.make<
      Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "runtime_request.updated" }>
    >();
  const watchers: Array<{
    predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean;
    deferred: Deferred.Deferred<ProviderAdapter.ProviderAdapterV2Event>;
  }> = [];
  const waitFor = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      const existing = events.find(predicate);
      if (existing) return existing;
      const deferred = yield* Deferred.make<ProviderAdapter.ProviderAdapterV2Event>();
      watchers.push({ predicate, deferred });
      return yield* Deferred.await(deferred);
    });
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        decodeEvent(event);
        events.push(event);
        for (const watcher of watchers) {
          if (watcher.predicate(event)) yield* Deferred.succeed(watcher.deferred, event);
        }
        if (event.type === "turn.terminal") return yield* Deferred.succeed(terminal, event);
        if (event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending")
          return yield* Deferred.succeed(question, event);
      }),
    ),
    Effect.forkChild({ startImmediately: true }),
  );
  const firstInput = turnInput(thread, yield* DateTime.now);
  yield* runtime.startTurn({ ...firstInput, message: { ...firstInput.message, text } });
  yield* Effect.promise(() => raw.prompted);
  return { raw, runtime, thread, events, terminal, question, waitFor, sessions, creates };
});
it.effect(
  "routes Pi status while active and idle without creating transcript events, then clears on worker exit",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const statuses = yield* PiExtensionStatuses.PiExtensionStatuses;
      const awaitText = (text: string) =>
        statuses.subscribe(threadId).pipe(
          Stream.filter((snapshot) => snapshot.statuses[0]?.text === text),
          Stream.runHead,
        );
      h.raw.emit({ type: "paperplane_ui_status", statuses: [{ key: "task", text: "active" }] });
      yield* awaitText("active");
      h.raw.settle();
      yield* Deferred.await(h.terminal);
      const transcriptEvents = h.events.length;
      h.raw.emit({ type: "paperplane_ui_status", statuses: [{ key: "task", text: "idle timer" }] });
      yield* awaitText("idle timer");
      assert.strictEqual(h.events.length, transcriptEvents);
      h.raw.emit({ type: "runtime_exited", error: "worker stopped" });
      yield* statuses.subscribe(threadId).pipe(
        Stream.filter((snapshot) => snapshot.statuses.length === 0),
        Stream.runHead,
      );
      assert.deepEqual(
        Option.getOrThrow(yield* statuses.subscribe(threadId).pipe(Stream.runHead)),
        { statuses: [] },
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("continues to stop autonomous SDK work outside a committed run", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    h.raw.settle();
    yield* Deferred.await(h.terminal);
    const startedTurns = h.events.filter((event) => event.type === "provider_turn.updated").length;
    h.raw.emit({ type: "agent_start" });
    yield* Effect.promise(() => h.raw.abortAcknowledged);
    assert.strictEqual(
      h.events.filter((event) => event.type === "provider_turn.updated").length,
      startedTurns,
    );
    // Aborting stray work must not end the session's status stream.
    const statuses = yield* PiExtensionStatuses.PiExtensionStatuses;
    h.raw.emit({ type: "paperplane_ui_status", statuses: [{ key: "task", text: "after abort" }] });
    yield* statuses.subscribe(threadId).pipe(
      Stream.filter((snapshot) => snapshot.statuses[0]?.text === "after abort"),
      Stream.runHead,
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("maps raw SDK messages/tools and finishes only at settlement", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    h.raw.emit({ type: "message_start", message: { role: "assistant" } });
    h.raw.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    });
    h.raw.emit({
      type: "tool_execution_start",
      toolCallId: "bash",
      toolName: "bash",
      args: { command: "pwd" },
    });
    h.raw.emit({
      type: "tool_execution_end",
      toolCallId: "bash",
      toolName: "bash",
      result: { content: [{ type: "text", text: "/workspace" }] },
      isError: false,
    });
    h.raw.emit({ type: "agent_end" });
    assert.isFalse(yield* Deferred.isDone(h.terminal));
    h.raw.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        stopReason: "stop",
      },
    });
    h.raw.settle();
    assert.strictEqual((yield* Deferred.await(h.terminal)).status, "completed");
    const items = h.events
      .filter((event) => event.type === "turn_item.updated")
      .map((event) => event.turnItem);
    assert.isTrue(
      items.some(
        (item) =>
          item.type === "command_execution" &&
          item.input === "pwd" &&
          item.output === "/workspace" &&
          item.status === "completed",
      ),
    );
    assert.isTrue(
      items.some(
        (item) => item.type === "assistant_message" && item.text === "Hello" && !item.streaming,
      ),
    );
    assert.isTrue(
      items.some(
        (item) => item.type === "system_notice" && item.message === "Fixture model fallback",
      ),
    );
    assert.isTrue(
      h.events.some(
        (event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.contextUsage?.contextUsageState !== "unavailable",
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
it.effect("does not publish empty assistant messages for tool-only SDK messages", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    h.raw.emit({ type: "message_start", message: { role: "assistant" } });
    h.raw.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "Plan" },
    });
    h.raw.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Plan" },
          { type: "toolCall", id: "bash", name: "bash", arguments: { command: "pwd" } },
        ],
        stopReason: "toolUse",
      },
    });
    h.raw.settle();
    yield* Deferred.await(h.terminal);
    assert.isFalse(
      h.events.some(
        (event) =>
          (event.type === "turn_item.updated" && event.turnItem.type === "assistant_message") ||
          event.type === "message.updated",
      ),
    );
    assert.isTrue(
      h.events.some(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "reasoning" &&
          event.turnItem.text === "Plan",
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
it.effect("routes multiline extension questions through live V2 request ids", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    h.raw.emit({
      type: "paperplane_ui_request",
      requestId: "native-editor",
      questions: [
        {
          id: "answer",
          header: "Pi extension",
          question: "Edit",
          options: [],
          initialAnswer: "First\nSecond",
          allowCustomAnswer: true,
        },
      ],
    });
    const question = (yield* Deferred.await(h.question)).runtimeRequest;
    assert.strictEqual(question.responseCapability.type, "live");
    assert.isFalse(yield* Deferred.isDone(h.terminal));
    yield* h.runtime.respondToRuntimeRequest({
      requestId: question.id,
      answers: { answer: " Revised\n" },
    });
    h.raw.settle();
    yield* Deferred.await(h.terminal);
    assert.deepEqual(h.raw.answers, [{ answer: " Revised\n" }]);
    assert.isTrue(
      h.events.some(
        (event) =>
          event.type === "runtime_request.updated" &&
          event.runtimeRequest.status === "resolved" &&
          event.runtimeRequest.answers?.answer === " Revised\n",
      ),
    );
    assert.isTrue(
      h.events.some(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "user_input_request" &&
          event.turnItem.questions[0]?.initialAnswer === "First\nSecond",
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
it.effect("preserves SDK failure ordering and fork-as-rollback", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    h.raw.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Provider failed",
      },
    });
    h.raw.settle();
    assert.strictEqual((yield* Deferred.await(h.terminal)).status, "failed");
    const turns = h.events.filter((event) => event.type === "provider_turn.updated");
    assert.strictEqual(turns.at(-1)?.providerTurn.nativeTurnRef?.nativeId, "user");
    yield* h.runtime.rollbackThread({
      providerThread: h.thread,
      target: {
        type: "thread_start",
        checkpointId: CheckpointId.make("checkpoint"),
        appRunOrdinal: 0,
      },
      providerThreadTurns: turns.map((event) => event.providerTurn),
    });
    assert.deepEqual(h.raw.forks, [null]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
it.effect("Stop acknowledgment cannot close a run before SDK settlement", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const snapshot = yield* h.runtime.readThreadSnapshot({ providerThread: h.thread });
    const turn = snapshot.providerTurns[0]!;
    const interrupted = yield* h.runtime
      .interruptTurn({ providerThread: h.thread, providerTurnId: turn.id })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.promise(() => h.raw.abortAcknowledged);
    assert.isFalse(yield* Deferred.isDone(h.terminal));
    h.raw.settle();
    assert.strictEqual((yield* Deferred.await(h.terminal)).status, "interrupted");
    yield* Fiber.join(interrupted);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
import { CheckpointId } from "@getpaperplane/contracts";

it.effect.each([false, true])("resumes the durable session after a worker crash, idle=%s", (idle) =>
  Effect.gen(function* () {
    const h = yield* setup();
    if (idle) {
      h.raw.settle();
      yield* Deferred.await(h.terminal);
    }
    h.raw.emit({ type: "runtime_exited", error: "worker exited" });
    yield* h.waitFor(
      (event) =>
        event.type === "provider_session.updated" && event.providerSession.status === "error",
    );
    const previousThread = h.events
      .filter((event) => event.type === "provider_thread.updated")
      .at(-1)!.providerThread;
    if (!idle) {
      const terminal = yield* Deferred.await(h.terminal);
      assert.strictEqual(terminal.status, "failed");
      assert.strictEqual(terminal.threadDisposition, "broken");
      assert.strictEqual(previousThread.status, "error");
    }
    const next = turnInput(previousThread, yield* DateTime.now);
    yield* h.runtime.startTurn({
      ...next,
      runOrdinal: 2,
      providerTurnOrdinal: 2,
      attemptId: RunAttemptId.make("second"),
    });
    const resumed = h.sessions[1]!;
    yield* Effect.promise(() => resumed.prompted);
    assert.strictEqual(h.creates[1]?.resumeSessionFile, h.raw.session.sessionFile);
    resumed.settle();
    const terminal = yield* h.waitFor(
      (event) => event.type === "turn.terminal" && event.runOrdinal === 2,
    );
    assert.strictEqual(terminal.type === "turn.terminal" && terminal.status, "completed");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "rolls back at provider turn boundaries, preserving steering and the latest turn's tail",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const current = (yield* h.runtime.readThreadSnapshot({ providerThread: h.thread }))
        .providerTurns[0]!;
      yield* h.runtime.steerTurn({
        threadId,
        runId: RunId.make("run"),
        providerThread: h.thread,
        providerTurnId: current.id,
        message: { ...turnInput(h.thread, yield* DateTime.now).message, text: "steer" },
      });
      const branch: PiSessionEntryLike[] = [
        { id: "user", parentId: null, message: { role: "user" } },
        { id: "assistant", parentId: "user", message: { role: "assistant" } },
        { id: "steer", parentId: "assistant", message: { role: "user" } },
        { id: "tail", parentId: "steer", message: { role: "assistant" } },
      ];
      h.raw.setBranch(branch);
      h.raw.settle();
      yield* Deferred.await(h.terminal);
      const target = (yield* h.runtime.readThreadSnapshot({ providerThread: h.thread }))
        .providerTurns[0]!;
      const rollbackTarget = {
        type: "provider_turn" as const,
        providerTurn: target,
        checkpointId: CheckpointId.make("checkpoint"),
        appRunOrdinal: 1,
      };
      yield* h.runtime.rollbackThread({
        providerThread: h.thread,
        target: rollbackTarget,
        providerThreadTurns: [target],
      });
      assert.deepEqual(h.raw.forks, ["tail"]);
      h.raw.setBranch([
        ...branch,
        { id: "next-user", parentId: "tail", message: { role: "user" } },
        { id: "next-answer", parentId: "next-user", message: { role: "assistant" } },
      ]);
      const next = {
        ...target,
        ordinal: 2,
        nativeTurnRef: { ...target.nativeTurnRef!, nativeId: "next-user" },
      };
      yield* h.runtime.rollbackThread({
        providerThread: h.thread,
        target: rollbackTarget,
        providerThreadTurns: [next, target],
      });
      assert.deepEqual(h.raw.forks, ["tail", "tail"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each(["/extension", "/compact"])(
  "records a distinct cursor for %s and rolls back across it",
  (command) =>
    Effect.gen(function* () {
      const initial: PiSessionEntryLike[] = [
        { id: "old-user", parentId: null, message: { role: "user" } },
        { id: "old-answer", parentId: "old-user", message: { role: "assistant" } },
      ];
      const h = yield* setup(command, initial);
      h.raw.settle();
      yield* Deferred.await(h.terminal);
      const target = (yield* h.runtime.readThreadSnapshot({ providerThread: h.thread }))
        .providerTurns[0]!;
      assert.strictEqual(target.nativeTurnRef?.nativeId, "paperplane:leaf:old-answer");
      const prior = {
        ...target,
        ordinal: 0,
        nativeTurnRef: { ...target.nativeTurnRef!, nativeId: "old-user" },
      };
      yield* h.runtime.rollbackThread({
        providerThread: h.thread,
        target: {
          type: "provider_turn",
          providerTurn: prior,
          checkpointId: CheckpointId.make("checkpoint"),
          appRunOrdinal: 0,
        },
        providerThreadTurns: [target, prior],
      });
      assert.deepEqual(h.raw.forks, ["old-answer"]);
      yield* h.runtime.rollbackThread({
        providerThread: h.thread,
        target: {
          type: "provider_turn",
          providerTurn: target,
          checkpointId: CheckpointId.make("checkpoint"),
          appRunOrdinal: 1,
        },
        providerThreadTurns: [target],
      });
      assert.deepEqual(h.raw.forks, [
        "old-answer",
        command === "/compact" ? "compacted" : "old-answer",
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each(["aborted", "error", "success"])("publishes %s compaction accurately", (outcome) =>
  Effect.gen(function* () {
    const h = yield* setup();
    h.raw.emit({ type: "compaction_start" });
    h.raw.emit({
      type: "compaction_end",
      aborted: outcome === "aborted",
      ...(outcome === "error" ? { errorMessage: "summary failed" } : {}),
    });
    h.raw.settle();
    yield* Deferred.await(h.terminal);
    const item = h.events
      .filter((event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction")
      .at(-1);
    assert.strictEqual(
      item?.type === "turn_item.updated" && item.turnItem.status,
      outcome === "aborted" ? "interrupted" : outcome === "error" ? "failed" : "completed",
    );
    if (outcome === "error")
      assert.strictEqual(
        item?.type === "turn_item.updated" &&
          item.turnItem.type === "compaction" &&
          item.turnItem.summary,
        "summary failed",
      );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each([false, true])("marks partial failed answers as failed, recovered=%s", (recovered) =>
  Effect.gen(function* () {
    const h = yield* setup();
    h.raw.emit({ type: "message_start", message: { role: "assistant" } });
    h.raw.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Partial" },
    });
    h.raw.emit({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "transient",
        content: [{ type: "text", text: "Partial" }],
      },
    });
    h.raw.emit({ type: "auto_retry_start", attempt: 1 });
    h.raw.emit({ type: "auto_retry_end", success: recovered });
    h.raw.settle();
    assert.strictEqual(
      (yield* Deferred.await(h.terminal)).status,
      recovered ? "completed" : "failed",
    );
    const items = h.events
      .filter((event) => event.type === "turn_item.updated")
      .map((event) => event.turnItem);
    assert.isTrue(
      items.some(
        (item) =>
          item.type === "assistant_message" &&
          item.text === "Partial" &&
          item.status === "failed" &&
          !item.streaming,
      ),
    );
    assert.isFalse(
      items.some((item) => item.type === "assistant_message" && item.status === "completed"),
    );
    assert.isTrue(
      items.some(
        (item) => item.type === "system_notice" && item.message === "Retrying (attempt 1)…",
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("shows bounded visible extension messages and keeps hidden messages hidden", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    for (const content of ["Visible", [{ type: "text", text: "x".repeat(20_000) }]])
      h.raw.emit({
        type: "message_end",
        message: { role: "custom", customType: "extension", display: true, content },
      });
    h.raw.emit({
      type: "message_end",
      message: { role: "custom", display: false, content: "Hidden" },
    });
    h.raw.settle();
    yield* Deferred.await(h.terminal);
    const notices = h.events
      .filter((event) => event.type === "turn_item.updated")
      .map((event) => event.turnItem);
    assert.isTrue(
      notices.some((item) => item.type === "system_notice" && item.message === "Visible"),
    );
    assert.isTrue(
      notices.some(
        (item) =>
          item.type === "system_notice" &&
          item.message.startsWith("xxxx") &&
          item.message.length <= 16_384,
      ),
    );
    assert.isFalse(
      notices.some((item) => item.type === "system_notice" && item.message === "Hidden"),
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("streams bounded worker progress before final command output", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    h.raw.emit({
      type: "tool_execution_start",
      toolCallId: "bash",
      toolName: "bash",
      args: { command: "pwd" },
    });
    h.raw.emit({
      type: "tool_execution_update",
      toolCallId: "bash",
      toolName: "bash",
      progress: "live output",
    });
    const update = yield* h.waitFor(
      (event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "command_execution" &&
        event.turnItem.output === "live output",
    );
    assert.strictEqual(update.type === "turn_item.updated" && update.turnItem.status, "running");
    assert.isFalse(yield* Deferred.isDone(h.terminal));
    h.raw.emit({
      type: "tool_execution_end",
      toolCallId: "bash",
      toolName: "bash",
      result: { content: [{ type: "text", text: "final output" }] },
    });
    h.raw.settle();
    yield* Deferred.await(h.terminal);
    assert.isTrue(
      h.events.some(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "command_execution" &&
          event.turnItem.output === "final output" &&
          event.turnItem.status === "completed",
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("reloads the session for rollback immediately after Stop", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    const statuses = yield* PiExtensionStatuses.PiExtensionStatuses;
    h.raw.emit({ type: "paperplane_ui_status", statuses: [{ key: "task", text: "working" }] });
    yield* statuses.subscribe(threadId).pipe(
      Stream.filter((snapshot) => snapshot.statuses.length > 0),
      Stream.runHead,
    );
    const turn = (yield* h.runtime.readThreadSnapshot({ providerThread: h.thread }))
      .providerTurns[0]!;
    const interrupted = yield* h.runtime
      .interruptTurn({ providerThread: h.thread, providerTurnId: turn.id })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.promise(() => h.raw.abortAcknowledged);
    assert.deepEqual(Option.getOrThrow(yield* statuses.subscribe(threadId).pipe(Stream.runHead)), {
      statuses: [],
    });
    h.raw.settle();
    yield* Fiber.join(interrupted);
    yield* h.runtime.rollbackThread({
      providerThread: h.thread,
      target: {
        type: "thread_start",
        checkpointId: CheckpointId.make("checkpoint"),
        appRunOrdinal: 0,
      },
      providerThreadTurns: [],
    });
    assert.strictEqual(h.creates[1]?.resumeSessionFile, h.raw.session.sessionFile);
    assert.deepEqual(h.sessions[1]?.forks, [null]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("does not reset unchanged SDK model and thinking selections", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    assert.deepEqual(h.raw.models, []);
    h.raw.settle();
    yield* Deferred.await(h.terminal);
    const next = turnInput(h.thread, yield* DateTime.now);
    yield* h.runtime.startTurn({
      ...next,
      attemptId: RunAttemptId.make("same-selection"),
      modelSelection: { ...selection, options: [{ id: "thinkingLevel", value: "high" }] },
    });
    assert.deepEqual(h.raw.models, []);
    assert.deepEqual(h.raw.thinkingLevels, []);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
