import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@getpaperplane/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as IdAllocator from "@getpaperplane/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@getpaperplane/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:github-session-allocation");
const unconfiguredProjectId = ProjectId.make("project:ambient-session-allocation");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const adapter = ProviderAdapter.ProviderAdapterV2.of({
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Allocation tests do not start provider processes"),
});
const settingsLayer = ServerSettings.layerTest();
const layerTest = ProviderReplayHarness.layerWithRegistry(
  { name: "github-session-allocation" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { runEffectWorker: false, serverSettingsLayer: settingsLayer },
).pipe(Layer.provideMerge(settingsLayer), Layer.provideMerge(IdAllocator.layer));

const createThread = Effect.fnUntraced(function* (threadId: ThreadId, configured = true) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${threadId}`),
    threadId,
    projectId: configured ? projectId : unconfiguredProjectId,
    title: "Session allocation",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: process.cwd(),
    createdBy: "user",
    creationSource: "web",
  });
});
const send = Effect.fnUntraced(function* (threadId: ThreadId, name: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`send:${threadId}:${name}`),
    threadId,
    messageId: MessageId.make(`message:${threadId}:${name}`),
    text: name,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  return yield* orchestrator.getThreadProjection(threadId);
});
const finish = Effect.fnUntraced(function* (projection: OrchestrationV2ThreadProjection) {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const run = projection.runs.at(-1)!;
  yield* sink.write({
    events: [
      {
        id: EventId.make(`finish:${run.id}`),
        type: "run.updated",
        threadId: projection.thread.id,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      } satisfies OrchestrationV2DomainEvent,
    ],
  });
});
const nativeThread = (projection: OrchestrationV2ThreadProjection) =>
  projection.providerThreads.find(
    (thread) => thread.id === projection.thread.activeProviderThreadId,
  )!;

it.effect("isolates selected GitHub accounts while unconfigured threads share their runtime", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const sharedId = ids.derive.providerSession({ providerInstanceId: modelSelection.instanceId });
    const first = ThreadId.make("thread:allocation-selected-a");
    const second = ThreadId.make("thread:allocation-selected-b");
    const third = ThreadId.make("thread:allocation-ambient-a");
    const fourth = ThreadId.make("thread:allocation-ambient-b");
    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [projectId]: { githubAccount: { host: "github.com", login: "alice" } },
      },
    });
    for (const threadId of [first, second]) yield* createThread(threadId);
    for (const threadId of [third, fourth]) yield* createThread(threadId, false);
    const firstSession = nativeThread(yield* send(first, "first")).providerSessionId;
    const secondSession = nativeThread(yield* send(second, "first")).providerSessionId;
    assert.notEqual(firstSession, sharedId);
    assert.notEqual(secondSession, sharedId);
    assert.notEqual(firstSession, secondSession);
    assert.equal(nativeThread(yield* send(third, "first")).providerSessionId, sharedId);
    assert.equal(nativeThread(yield* send(fourth, "first")).providerSessionId, sharedId);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "moves an existing shared thread to a retained private session without replacing native history",
  () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const sink = yield* EventSink.EventSinkV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:allocation-migration");
      yield* createThread(threadId);
      const original = yield* send(threadId, "before-selection");
      const previous = nativeThread(original);
      const now = yield* DateTime.now;
      const nativeThreadRef = {
        driver: adapter.driver,
        nativeId: "native-history",
        strength: "strong",
      } as const;
      yield* sink.write({
        events: [
          {
            id: EventId.make("attach-native-history"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: { ...previous, nativeThreadRef, status: "idle" },
          },
        ],
      });
      yield* finish(original);
      yield* settings.updateSettings({
        projectSettingsOverrides: {
          [projectId]: { githubAccount: { host: "github.com", login: "alice" } },
        },
      });
      let current = yield* send(threadId, "selected");
      const privateId = nativeThread(current).providerSessionId;
      assert.notEqual(privateId, previous.providerSessionId);
      for (const selection of [
        { host: "github.com", login: "bob" },
        { host: "git.example.com", login: "bob" },
        null,
      ]) {
        assert.equal(nativeThread(current).id, previous.id);
        assert.deepEqual(nativeThread(current).nativeThreadRef, nativeThreadRef);
        assert.equal(nativeThread(current).providerSessionId, privateId);
        yield* finish(current);
        yield* settings.updateSettings({
          projectSettingsOverrides: {
            [projectId]: selection === null ? null : { githubAccount: selection },
          },
        });
        current = yield* send(
          threadId,
          `selection:${selection?.host ?? "none"}:${selection?.login ?? "none"}`,
        );
      }
      assert.equal(nativeThread(current).providerSessionId, privateId);
      assert.deepEqual(nativeThread(current).nativeThreadRef, nativeThreadRef);
      const peer = ThreadId.make("thread:allocation-still-shared");
      yield* createThread(peer, false);
      assert.equal(
        nativeThread(yield* send(peer, "peer")).providerSessionId,
        previous.providerSessionId,
      );
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).providerThreads.length, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("rechecks GitHub selection when activating a queued run", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:allocation-queue");
    yield* createThread(threadId);
    const original = yield* send(threadId, "running");
    const previous = nativeThread(original);
    const queued = yield* send(threadId, "queued");
    assert.equal(queued.runs.at(-1)?.status, "queued");
    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [projectId]: { githubAccount: { host: "github.com", login: "alice" } },
      },
    });
    yield* finish(original);
    yield* orchestrator.dispatch({
      type: "queue.resume",
      commandId: CommandId.make("resume:github-queue"),
      threadId,
    });
    const activated = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(activated.runs.at(-1)?.status, "starting");
    assert.notEqual(nativeThread(activated).providerSessionId, previous.providerSessionId);
    assert.equal(nativeThread(activated).id, previous.id);
  }).pipe(Effect.provide(layerTest)),
);
