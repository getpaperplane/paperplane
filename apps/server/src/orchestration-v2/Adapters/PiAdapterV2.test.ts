import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as IdAllocator from "@rove-code/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@rove-code/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@rove-code/provider-core/server/ProviderAdapter";
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
} from "@rove-code/contracts";
import { ServerConfig } from "../../config.ts";
import { makePiAdapterV2 } from "./PiAdapterV2.ts";
import type { PiSessionLike, PiSessionEventLike } from "../../provider/Layers/PiAdapter.ts";
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
  ServerConfig.layerTest(process.cwd(), { prefix: "rove-pi-v2-" }),
).pipe(Layer.provideMerge(NodeServices.layer));
const decodeEvent = Schema.decodeUnknownSync(ProviderAdapter.ProviderAdapterV2Event);
function rawSession() {
  let listener: (event: PiSessionEventLike) => void = () => {};
  let streaming = true;
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
    prompt: () => pending,
    followUp: async () => {},
    abort: async () => {
      abortAcknowledged.resolve();
    },
    dispose: () => {
      release();
    },
    setModel: async () => {},
    setThinkingLevel: () => {},
    subscribe: (callback) => {
      listener = callback;
      return () => {
        listener = () => {};
      };
    },
    respondToUserInput: (native, answer) => {
      answers.push(answer);
      listener({
        type: "rove_ui_resolved",
        requestId: native,
        answers: { answer: typeof answer.answer === "string" ? answer.answer : "" },
      });
      return true;
    },
    getBranch: () => [
      { id: "user", parentId: null, type: "message", message: { role: "user" } },
      { id: "assistant", parentId: "user", type: "message", message: { role: "assistant" } },
    ],
    getLeafId: () => "assistant",
    getSessionStats: () => ({ contextUsage: { tokens: 12, contextWindow: 64000, percent: 0.01 } }),
    fork: async (entry) => {
      forks.push(entry);
    },
  };
  return {
    session,
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
const setup = Effect.fn(function* () {
  const raw = rawSession();
  const adapter = yield* makePiAdapterV2({ instanceId, createSession: async () => raw.session });
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
  const child = yield* Deferred.make<void>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => {
      decodeEvent(event);
      events.push(event);
      if (event.type === "turn.terminal") return Deferred.succeed(terminal, event);
      if (event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending")
        return Deferred.succeed(question, event);
      if (event.type === "subagent.updated" && event.subagent.status === "completed")
        return Deferred.succeed(child, undefined);
      return Effect.void;
    }),
    Effect.forkChild({ startImmediately: true }),
  );
  yield* runtime.startTurn(turnInput(thread, yield* DateTime.now));
  return { raw, runtime, thread, events, terminal, question, child };
});
it.effect("maps raw SDK messages/tools and finishes only at settlement, after children", () =>
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
    h.raw.emit({
      type: "rove_agent_task",
      task: {
        type: "task.started",
        payload: { taskId: "child", title: "Inspect", description: "inspect", toolUseId: "bash" },
      },
    });
    h.raw.emit({
      type: "rove_agent_task",
      task: {
        type: "task.completed",
        payload: { taskId: "child", status: "completed", summary: "Child done" },
      },
    });
    h.raw.emit({ type: "agent_end" });
    yield* Deferred.await(h.child);
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
    const children = h.events
      .filter((event) => event.type === "subagent.updated")
      .map((event) => event.subagent);
    assert.strictEqual(children[0]?.id, children[1]?.id);
    assert.strictEqual(children[0]?.parentNodeId, "root");
    assert.isTrue(
      h.events.some(
        (event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.contextUsage?.contextUsageState !== "unavailable",
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
it.effect("routes multiline extension questions through live V2 request ids", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    h.raw.emit({
      type: "rove_ui_request",
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
import { CheckpointId } from "@rove-code/contracts";
