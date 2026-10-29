import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
} from "@getpaperplane/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as BackgroundCommands from "./BackgroundCommandService.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as IdAllocator from "@getpaperplane/provider-core/server/IdAllocator";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";

const instanceId = ProviderInstanceId.make("codex");
const database = SqlitePersistence.layerMemory;
const base = ProviderReplayHarness.layerWithRegistry(
  { name: "owned-background" },
  ProviderAdapterRegistry.layerFromAdapters(
    ["codex", "pi"].map((name) => ({
      instanceId: ProviderInstanceId.make(name),
      driver: ProviderDriverKind.make(name),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Tests do not start a provider"),
    })),
  ),
  { runEffectWorker: false, databaseLayer: database },
);
const layer = Layer.mergeAll(
  base,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  EffectOutbox.layer.pipe(Layer.provide(database)),
).pipe(Layer.provideMerge(NodeServices.layer));

const setup = Effect.fn("backgroundTest.setup")(function* (worktree = true) {
  const engine = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const cwd = worktree ? yield* fs.makeTempDirectoryScoped() : root;
  const threadId = ThreadId.make("thread:owned-background");
  const projectId = ProjectId.make("project:owned-background");
  const now = yield* DateTime.now;
  const iso = DateTime.formatIso(now);
  yield* sink.commitProjectCommand({
    commandId: CommandId.make("project"),
    projectId,
    commandType: "project.create",
    acceptedAt: now,
    event: {
      eventId: EventId.make("project"),
      aggregateKind: "project",
      aggregateId: projectId,
      type: "project.created",
      occurredAt: iso,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        projectId,
        title: "Background",
        workspaceRoot: root,
        defaultModelSelection: null,
        scripts: [],
        createdAt: iso,
        updatedAt: iso,
      },
    },
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("thread"),
    threadId,
    projectId,
    title: "Background",
    modelSelection: { instanceId, model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: worktree ? cwd : null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* engine.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("message"),
    threadId,
    messageId: MessageId.make("message"),
    text: "Start a server",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const run = (yield* engine.getThreadProjection(threadId)).runs[0];
  assert.ok(run);
  return {
    engine,
    sink,
    fs,
    threadId,
    cwd,
    root,
    run,
    commands: yield* BackgroundCommands.BackgroundCommandService,
  };
});

const awaitItem = (threadId: ThreadId, itemId: TurnItemId, terminal = true) =>
  Orchestrator.OrchestratorV2.use((engine) =>
    engine.streamDomainEvents.pipe(
      Stream.filter(
        (event) =>
          event.type === "turn-item.updated" &&
          event.payload.id === itemId &&
          (terminal
            ? ["completed", "failed", "interrupted"].includes(event.payload.status)
            : event.payload.status === "running"),
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    ),
  );
const settleRun = Effect.fn("backgroundTest.settleRun")(function* (
  sink: EventSink.EventSinkV2["Service"],
  run: OrchestrationV2Run,
) {
  const now = yield* DateTime.now;
  yield* sink.write({
    events: [
      {
        id: EventId.make(`settled:${run.id}`),
        type: "run.updated",
        threadId: run.threadId,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      },
    ],
  });
});

it.live(
  "commits one launch for duplicate starts, rejects conflicting input, and isolates status and Stop",
  () =>
    Effect.gen(function* () {
      const { commands, threadId, fs, cwd } = yield* setup();
      const input = {
        threadId,
        providerInstanceId: instanceId,
        clientRequestId: "same",
        command: "printf once >> once",
      };
      const first = yield* commands.start(input);
      assert.equal(yield* commands.start(input), first);
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const engine = yield* Orchestrator.OrchestratorV2;
      const start = (yield* engine.getThreadProjection(threadId)).turnItems.find(
        (item) => item.id === first,
      );
      assert.ok(start?.type === "command_execution");
      const original = yield* engine.dispatch({
        type: "background-command.start",
        threadId,
        providerInstanceId: instanceId,
        itemId: first,
        clientRequestId: input.clientRequestId,
        generation: start.execution?.generation ?? "",
        command: input.command,
        commandId: CommandId.make(`background-start:${first.slice("background:".length)}`),
      });
      const events = original.storedEvents;
      assert.equal(events.length, 1);
      const effects = yield* outbox.listByCommandId(
        CommandId.make(`background-start:${first.slice("background:".length)}`),
      );
      assert.equal(
        effects.filter((effect) => effect.request.type === "background-command.launch").length,
        1,
      );
      assert.equal(
        (yield* Effect.exit(commands.start({ ...input, command: "printf twice" })))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.exit(commands.status({ threadId: ThreadId.make("other"), itemId: first })))
          ._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.exit(commands.stop({ threadId: ThreadId.make("other"), itemId: first })))
          ._tag,
        "Failure",
      );
      const finished = yield* awaitItem(threadId, first);
      yield* outbox.cancelUnsettled({
        threadId,
        effectTypes: ["provider-turn.start"],
        reason: "No provider process in this test",
      });
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
      yield* commands.launch({ threadId, itemId: first });
      yield* Fiber.join(finished);
      assert.equal(yield* fs.readFileString(`${cwd}/once`), "once");
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("Stop before launch never spawns the command and settles from the termination effect", () =>
  Effect.gen(function* () {
    const { commands, threadId, fs, cwd } = yield* setup();
    const itemId = yield* commands.start({
      threadId,
      providerInstanceId: instanceId,
      clientRequestId: "cancel",
      command: "echo started > spawned",
    });
    yield* commands.stop({ threadId, itemId });
    assert.equal((yield* commands.status({ threadId, itemId })).status, "pending");
    yield* commands.launch({ threadId, itemId });
    yield* commands.terminate({ threadId, itemId });
    assert.equal((yield* commands.status({ threadId, itemId })).status, "interrupted");
    assert.equal(yield* fs.exists(`${cwd}/spawned`), false);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live.each([false, true])(
  "runs in the durable cwd (worktree=%s) and bounds persisted output",
  (worktree) =>
    Effect.gen(function* () {
      const { commands, threadId, cwd, fs } = yield* setup(worktree);
      const itemId = yield* commands.start({
        threadId,
        providerInstanceId: instanceId,
        clientRequestId: "cwd",
        command: "pwd > executed-in; head -c 70000 /dev/zero | tr '\\0' x; printf '\\nfinished'",
      });
      assert.equal((yield* commands.status({ threadId, itemId })).execution?.cwd, cwd);
      const finished = yield* awaitItem(threadId, itemId);
      yield* commands.launch({ threadId, itemId });
      yield* Fiber.join(finished);
      const item = yield* commands.status({ threadId, itemId });
      assert.equal(yield* fs.readFileString(`${cwd}/executed-in`), `${cwd}\n`);
      assert.equal(item.status, "completed");
      assert.equal(item.exitCode, 0);
      assert.equal(item.output?.length, 32768);
      assert.ok(item.output?.endsWith("\nfinished"));
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live(
  "an owned command outlives its turn and provider switch; thread Stop stops it and the PR watch",
  () =>
    Effect.gen(function* () {
      const { commands, engine, sink, threadId, run } = yield* setup();
      const command = `node -e 'process.on("SIGTERM",()=>process.exit(0));process.stdout.write("ready");setInterval(()=>{},100000)'`;
      const itemId = yield* commands.start({
        threadId,
        providerInstanceId: instanceId,
        clientRequestId: "server",
        command,
        title: "Start dev server in background",
      });
      const hub = yield* CommandOutputHub.CommandOutputHub;
      const ready = yield* hub.subscribe({ threadId, itemId }).pipe(
        Stream.filter((frame) => frame.text.includes("ready")),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* commands.launch({ threadId, itemId });
      yield* Fiber.join(ready);
      yield* settleRun(sink, run);
      yield* engine.dispatch({
        type: "provider.switch",
        commandId: CommandId.make("switch-provider"),
        threadId,
        modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "test" },
      });
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("next-run"),
        threadId,
        messageId: MessageId.make("next-run"),
        text: "More work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const laterRun = (yield* engine.getThreadProjection(threadId)).runs.find(
        (candidate) => candidate.id !== run.id,
      );
      assert.ok(laterRun);
      yield* settleRun(sink, laterRun);
      yield* engine.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("watch"),
        threadId,
        host: "github.com",
        repository: "test/repo",
        number: 1,
        watching: true,
        link: { url: "https://github.com/test/repo/pull/1", source: "agent" },
      });
      const shell = yield* engine.getThreadShell(threadId);
      assert.equal(
        shell?.pendingBackgroundTasks?.filter((task) => task.kind === "command").length,
        1,
      );
      assert.equal(
        shell?.pendingBackgroundTasks?.filter((task) => task.kind === "monitor").length,
        1,
      );
      assert.equal((yield* commands.status({ threadId, itemId })).status, "running");
      yield* engine.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-all"),
        threadId,
      });
      assert.equal((yield* commands.status({ threadId, itemId })).status, "running");
      assert.equal((yield* commands.status({ threadId, itemId })).execution?.stopRequested, true);
      yield* commands.terminate({ threadId, itemId });
      assert.equal((yield* commands.status({ threadId, itemId })).status, "interrupted");
      assert.deepEqual((yield* engine.getThreadShell(threadId))?.pendingBackgroundTasks, []);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

const recoveryLayer = ProviderRuntimeRecovery.layer.pipe(
  Layer.provideMerge(layer),
  Layer.provide(IdAllocator.layer),
  Layer.provide(ServerSettings.layerTest()),
);
it.live(
  "process-loss recovery interrupts owned items and cancels launch effects without relaunching",
  () =>
    Effect.gen(function* () {
      const { commands, threadId, fs, cwd } = yield* setup();
      const itemId = yield* commands.start({
        threadId,
        providerInstanceId: instanceId,
        clientRequestId: "lost",
        command: "echo bad > relaunched",
      });
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
      const item = yield* commands.status({ threadId, itemId });
      assert.equal(item.status, "interrupted");
      assert.ok(item.output?.includes("ownership was lost"));
      const effects = yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
        CommandId.make(`background-start:${itemId.slice("background:".length)}`),
      );
      assert.equal(effects[0]?.status, "cancelled");
      yield* commands.launch({ threadId, itemId });
      assert.equal(yield* fs.exists(`${cwd}/relaunched`), false);
    }).pipe(Effect.scoped, Effect.provide(recoveryLayer)),
);

it.live("a stale generation is never launched, even before recovery drains the outbox", () =>
  Effect.gen(function* () {
    const { commands, sink, threadId, fs, cwd } = yield* setup();
    const itemId = yield* commands.start({
      threadId,
      providerInstanceId: instanceId,
      clientRequestId: "old",
      command: "echo bad > stale",
    });
    const item = yield* commands.status({ threadId, itemId });
    assert.ok(item.execution);
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make("stale-generation"),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...item,
            execution: { ...item.execution, generation: "previous-server-process" },
          },
        },
      ],
    });
    yield* commands.launch({ threadId, itemId });
    assert.equal((yield* commands.status({ threadId, itemId })).status, "interrupted");
    assert.equal(yield* fs.exists(`${cwd}/stale`), false);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live.each(["stop", "delete", "shutdown"] as const)(
  "%s terminates the captured process tree and awaits its signal handlers",
  (action) =>
    Effect.gen(function* () {
      const { commands, engine, threadId, fs, cwd } = yield* setup();
      yield* fs.writeFileString(
        `${cwd}/child.cjs`,
        `const fs = require("node:fs"); process.on("SIGTERM", () => { fs.writeFileSync("child-stopped", "SIGTERM"); process.exit(0); }); process.stdout.write("ready"); setInterval(() => {}, 100000);`,
      );
      yield* fs.writeFileString(
        `${cwd}/parent.cjs`,
        `const {spawn} = require("node:child_process"); const fs = require("node:fs"); const child = spawn(process.execPath, ["child.cjs"], {stdio:["ignore","pipe","inherit"]}); child.stdout.pipe(process.stdout); process.on("SIGTERM", () => { fs.writeFileSync("parent-stopped", "SIGTERM"); }); child.on("exit", () => process.exit(0));`,
      );
      const itemId = yield* commands.start({
        threadId,
        providerInstanceId: instanceId,
        clientRequestId: "tree",
        command: "node parent.cjs",
      });
      const hub = yield* CommandOutputHub.CommandOutputHub;
      const ready = yield* hub.subscribe({ threadId, itemId }).pipe(
        Stream.filter((frame) => frame.text.includes("ready")),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* commands.launch({ threadId, itemId });
      yield* Fiber.join(ready);
      if (action === "stop") {
        yield* commands.stop({ threadId, itemId });
        assert.equal((yield* commands.status({ threadId, itemId })).status, "running");
        yield* commands.terminate({ threadId, itemId });
        yield* commands.terminate({ threadId, itemId });
      } else if (action === "delete") {
        yield* engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("delete"),
          threadId,
        });
        yield* commands.terminate({ threadId });
      } else yield* commands.shutdown;
      assert.equal(yield* fs.readFileString(`${cwd}/child-stopped`), "SIGTERM");
      assert.equal(yield* fs.readFileString(`${cwd}/parent-stopped`), "SIGTERM");
      assert.equal((yield* commands.status({ threadId, itemId })).status, "interrupted");
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("a deleted thread's delayed launch never spawns", () =>
  Effect.gen(function* () {
    const { commands, engine, threadId, fs, cwd } = yield* setup();
    const itemId = yield* commands.start({
      threadId,
      providerInstanceId: instanceId,
      clientRequestId: "deleted",
      command: "echo bad > deleted",
    });
    yield* engine.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete"),
      threadId,
    });
    yield* commands.launch({ threadId, itemId });
    assert.equal((yield* commands.status({ threadId, itemId })).status, "interrupted");
    assert.equal(yield* fs.exists(`${cwd}/deleted`), false);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("interrupting an older run cancels only its owned commands and preserves newer work", () =>
  Effect.gen(function* () {
    const { commands, engine, sink, threadId, run, cwd, fs } = yield* setup();
    const oldItemId = yield* commands.start({
      threadId,
      providerInstanceId: instanceId,
      clientRequestId: "old-command",
      command: "echo old > old",
    });
    yield* settleRun(sink, run);
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("later"),
      threadId,
      messageId: MessageId.make("later"),
      text: "Next",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const newItemId = yield* commands.start({
      threadId,
      providerInstanceId: instanceId,
      clientRequestId: "new-command",
      command: "printf new > new",
    });
    yield* engine.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("stop-old"),
      threadId,
      runId: run.id,
    });
    assert.equal(
      (yield* commands.status({ threadId, itemId: oldItemId })).execution?.stopRequested,
      true,
    );
    assert.equal(
      (yield* commands.status({ threadId, itemId: newItemId })).execution?.stopRequested,
      false,
    );
    yield* commands.launch({ threadId, itemId: oldItemId });
    const finished = yield* awaitItem(threadId, newItemId);
    yield* commands.launch({ threadId, itemId: newItemId });
    yield* Fiber.join(finished);
    assert.equal(yield* fs.exists(`${cwd}/old`), false);
    assert.equal(yield* fs.readFileString(`${cwd}/new`), "new");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
