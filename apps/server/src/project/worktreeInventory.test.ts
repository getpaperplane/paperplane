import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  EventId,
  MessageId,
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  RuntimeRequestId,
  type OrchestrationV2RuntimeRequest,
  RunId,
  type OrchestrationV2Run,
  type OrchestrationV2AppThread,
  type OrchestrationProjectShell,
  type TerminalSummary,
} from "@getpaperplane/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import {
  ProjectionStoreV2,
  layer as projectionLayer,
} from "../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2, layer as projectLayer } from "../orchestration-v2/ProjectStore.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { GitVcsDriver, layer as GitVcsDriverLayer } from "../vcs/GitVcsDriver.ts";
import {
  WorktreeInventory,
  layer as inventoryLayer,
  parseWorktreeInventory,
  worktreeLastActivity,
} from "./worktreeInventory.ts";

const TestLayer = Layer.mergeAll(GitVcsDriverLayer, projectionLayer, projectLayer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "rove-worktree-inventory-" })),
  Layer.provideMerge(NodeServices.layer),
);
const projectId = ProjectId.make("project-1");
const createdAt = "2026-01-01T00:00:00.000Z";

function thread(
  worktreePath: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread {
  const now = DateTime.makeUnsafe(createdAt);
  const id = overrides.id ?? ThreadId.make("thread-1");
  return {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId,
    title: "Feature work",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.3-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature",
    worktreePath,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const driver = yield* GitVcsDriver;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "rove-inventory-repo-" });
  const git = (args: readonly string[], directory = cwd) =>
    driver.execute({ operation: "WorktreeInventory.test", cwd: directory, args });
  yield* git(["init", "--initial-branch=main"]);
  yield* git(["config", "user.name", "Worktree test"]);
  yield* git(["config", "user.email", "worktree@example.test"]);
  yield* fs.writeFileString(path.join(cwd, "README.md"), "example\n");
  yield* fs.writeFileString(path.join(cwd, ".gitignore"), "node_modules/\n.env\nbuild/\n");
  yield* git(["add", "."]);
  yield* git(["commit", "-m", "initial"]);
  const worktreePath = path.join(config.worktreesDir, "feature");
  yield* fs.makeDirectory(config.worktreesDir, { recursive: true });
  yield* git(["worktree", "add", "-b", "feature", worktreePath]);
  const projects: OrchestrationProjectShell[] = [
    {
      id: projectId,
      title: "Example",
      workspaceRoot: cwd,
      defaultModelSelection: null,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
    },
  ];
  const projections = yield* ProjectionStoreV2;
  const projectStore = yield* ProjectStoreV2;
  let eventSequence = 0;
  const addProject = Effect.fnUntraced(function* (project: OrchestrationProjectShell) {
    yield* projectStore.apply({
      sequence: ++eventSequence,
      eventId: EventId.make(`project:${eventSequence}`),
      aggregateKind: "project",
      aggregateId: project.id,
      occurredAt: createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: { ...project, projectId: project.id },
    });
  });
  yield* addProject(projects[0]!);
  const addThread = Effect.fnUntraced(function* (value: OrchestrationV2AppThread) {
    yield* projections.apply({
      id: EventId.make(`thread:${++eventSequence}`),
      type: "thread.created",
      threadId: value.id,
      occurredAt: value.createdAt,
      payload: value,
    });
  });
  const addRun = Effect.fnUntraced(function* (
    status: OrchestrationV2Run["status"],
    queueHeld = false,
  ) {
    const now = yield* DateTime.now;
    const id = RunId.make(`run:${++eventSequence}`);
    yield* projections.apply({
      id: EventId.make(`event:${eventSequence}`),
      type: "run.created",
      threadId: ThreadId.make("thread-1"),
      runId: id,
      occurredAt: now,
      payload: {
        id,
        threadId: ThreadId.make("thread-1"),
        ordinal: eventSequence,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: thread(worktreePath).modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make(`message:${eventSequence}`),
        rootNodeId: NodeId.make(`node:${eventSequence}`),
        activeAttemptId: null,
        status,
        queueHeld,
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
  });
  const addMessage = Effect.fnUntraced(function* (at: DateTime.Utc) {
    yield* projections.apply({
      id: EventId.make(`event:${++eventSequence}`),
      type: "message.updated",
      threadId: ThreadId.make("thread-1"),
      occurredAt: at,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: MessageId.make(`message:${eventSequence}`),
        threadId: ThreadId.make("thread-1"),
        runId: null,
        nodeId: null,
        role: "user",
        text: "Work on this",
        attachments: [],
        streaming: false,
        createdAt: at,
        updatedAt: at,
      },
    });
  });
  const addSession = Effect.fnUntraced(function* (status: "ready" | "stopped" | "error" = "ready") {
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`event:${++eventSequence}`),
      type: "provider-session.attached",
      threadId: ThreadId.make("outside-thread"),
      occurredAt: now,
      payload: {
        id: ProviderSessionId.make("session:outside"),
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        status,
        cwd: worktreePath,
        model: null,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
  });
  const setRequest = Effect.fnUntraced(function* (
    kind: OrchestrationV2RuntimeRequest["kind"],
    status: "pending" | "resolved",
  ) {
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`event:${++eventSequence}`),
      type: "runtime-request.updated",
      threadId: ThreadId.make("thread-1"),
      occurredAt: now,
      payload: {
        id: RuntimeRequestId.make("request:inventory"),
        nodeId: NodeId.make("node:request"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind,
        status,
        responseCapability: { type: "not_resumable", reason: "runtime stopped" },
        createdAt: now,
        resolvedAt: status === "resolved" ? now : null,
      },
    });
  });
  const setBackground = Effect.fnUntraced(function* (pending: boolean) {
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`event:${++eventSequence}`),
      type: "provider-thread.updated",
      threadId: ThreadId.make("thread-1"),
      occurredAt: now,
      payload: {
        id: ProviderThreadId.make("provider-thread:inventory"),
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: null,
        appThreadId: ThreadId.make("thread-1"),
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: pending ? [{ taskId: "background", kind: "background_task" }] : [],
        createdAt: now,
        updatedAt: now,
      },
    });
  });
  const terminalEntries: TerminalSummary[] = [];
  const liveSessionIds = new Set<ProviderSessionId>();
  let subscriptions = 0;
  const operations: string[] = [];
  const inventory = yield* WorktreeInventory.pipe(
    Effect.provide(inventoryLayer),
    Effect.provideService(GitVcsDriver, {
      ...driver,
      execute: (input) => {
        operations.push(input.operation);
        return driver.execute(input);
      },
    }),
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProviderSessionManagerV2, {
          isLive: (id) => Effect.succeed(liveSessionIds.has(id)),
        }),
        Layer.mock(TerminalManager, {
          subscribeMetadata: (listener) =>
            Effect.gen(function* () {
              subscriptions++;
              yield* listener({ type: "snapshot", terminals: terminalEntries });
              return () => {
                subscriptions--;
              };
            }),
        }),
      ),
    ),
  );
  return {
    fs,
    path,
    cwd,
    worktreePath,
    inventory,
    projects,
    addProject,
    addThread,
    addRun,
    addMessage,
    addSession,
    setRequest,
    setBackground,
    projections,
    liveSessionIds,
    terminalEntries,
    git,
    subscriptions: () => subscriptions,
    operations,
  };
});

const firstEntry = (inventory: WorktreeInventory["Service"]) =>
  inventory.list({}).pipe(
    Effect.flatMap((result) =>
      inventory.inspect({
        projectId: result.worktrees[0]!.projectId,
        path: result.worktrees[0]!.path,
      }),
    ),
  );

describe("worktree inventory", () => {
  it("parses paths and lock reasons containing whitespace without unquoting them", () => {
    const entries = parseWorktreeInventory(
      "worktree /repo\0HEAD abc\0branch refs/heads/main\0\0worktree /work tree/line\nbreak\0HEAD def\0branch refs/heads/feature\0locked a\nb\0\0worktree /missing\0HEAD 123\0detached\0prunable missing\0\0",
    );
    assert.strictEqual(entries.length, 3);
    assert.strictEqual(entries[1]!.path, "/work tree/line\nbreak");
    assert.isTrue(entries[0]!.main);
    assert.isTrue(entries[1]!.locked);
    assert.isTrue(entries[2]!.prunable);
    assert.isNull(entries[2]!.branch);
  });

  it.effect("discovers a worktree with no thread and excludes the main checkout", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, fs, subscriptions, operations } = yield* fixture;
      const result = yield* inventory.list({});
      assert.strictEqual(result.worktrees.length, 1);
      assert.strictEqual(result.worktrees[0]!.path, yield* fs.realPath(worktreePath));
      assert.isNull(result.worktrees[0]!.lastActivityAt);
      assert.isNull(result.worktrees[0]!.removalBlockers);
      assert.strictEqual(subscriptions(), 0);
      assert.deepStrictEqual(operations, ["WorktreeInventory.discover"]);
      const checked = yield* inventory.inspect({ projectId, path: worktreePath });
      assert.deepStrictEqual(checked.removalBlockers, []);
      assert.isTrue(operations.includes("WorktreeInventory.localChanges"));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("does not scan checkout files when listing many managed worktrees", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, path, git, operations } = yield* fixture;
      for (let index = 0; index < 12; index++) {
        yield* git([
          "worktree",
          "add",
          "-b",
          `extra-${index}`,
          path.join(path.dirname(worktreePath), `extra-${index}`),
        ]);
      }
      const result = yield* inventory.list({});
      assert.strictEqual(result.worktrees.length, 13);
      assert.isTrue(
        result.worktrees.every((entry) => entry.managed && entry.removalBlockers === null),
      );
      assert.deepStrictEqual(operations, ["WorktreeInventory.discover"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("joins archived activity and ignores metadata refresh timestamps", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, addThread, addMessage } = yield* fixture;
      const activityAt = "2026-02-01T00:00:00.000Z";
      yield* addThread(
        thread(worktreePath, {
          archivedAt: DateTime.makeUnsafe(activityAt),
          updatedAt: DateTime.makeUnsafe("2026-03-01T00:00:00.000Z"),
        }),
      );
      yield* addMessage(DateTime.makeUnsafe(activityAt));
      const entry = yield* firstEntry(inventory);
      assert.strictEqual(entry.lastActivityAt, activityAt);
      assert.isTrue(entry.threads[0]!.archived);
      assert.deepStrictEqual(entry.removalBlockers, []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("filters projects and deduplicates worktrees across checkouts of one repository", () =>
    Effect.gen(function* () {
      const { inventory, projects, worktreePath, addProject } = yield* fixture;
      yield* addProject({
        ...projects[0]!,
        id: ProjectId.make("project-2"),
        workspaceRoot: worktreePath,
      });
      assert.strictEqual((yield* inventory.list({})).worktrees.length, 1);
      assert.strictEqual((yield* inventory.list({ projectIds: [] })).worktrees.length, 0);
      assert.strictEqual((yield* inventory.list({ projectIds: [projectId] })).worktrees.length, 1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reports repository failures instead of presenting an empty successful scan", () =>
    Effect.gen(function* () {
      const { inventory, projects, fs, addProject } = yield* fixture;
      const missing = yield* fs.makeTempDirectoryScoped({ prefix: "rove-inventory-not-git-" });
      yield* addProject({
        ...projects[0]!,
        id: ProjectId.make("project-2"),
        workspaceRoot: missing,
      });
      const result = yield* inventory.list({});
      assert.strictEqual(result.worktrees.length, 1);
      assert.strictEqual(result.issues.length, 1);
      assert.strictEqual(result.issues[0]!.projectId, ProjectId.make("project-2"));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("removes only the checkout while preserving its branch and thread records", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, addThread, projections, fs, git } = yield* fixture;
      yield* addThread(thread(worktreePath));
      const entry = yield* firstEntry(inventory);
      yield* inventory.remove({
        projectId,
        path: entry.path,
        expectedHead: entry.head,
        expectedBranch: entry.branch,
      });
      assert.isFalse(yield* fs.exists(worktreePath));
      assert.strictEqual(
        (yield* projections.getThread(ThreadId.make("thread-1"))).worktreePath,
        worktreePath,
      );
      assert.strictEqual((yield* git(["rev-parse", "feature"])).stdout.trim(), entry.head);
      assert.strictEqual((yield* inventory.list({})).worktrees.length, 0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rechecks local changes created after the inventory was loaded", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, fs, path } = yield* fixture;
      const entry = yield* firstEntry(inventory);
      yield* fs.writeFileString(path.join(worktreePath, "notes.txt"), "keep this");
      const failure = yield* inventory
        .remove({
          projectId,
          path: entry.path,
          expectedHead: entry.head,
          expectedBranch: entry.branch,
        })
        .pipe(Effect.flip);
      assert.include(failure.detail, "local changes");
      assert.isTrue(yield* fs.exists(worktreePath));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps ignored secrets but allows reproducible dependency installs", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, fs, path } = yield* fixture;
      yield* fs.makeDirectory(path.join(worktreePath, "node_modules"));
      yield* fs.writeFileString(
        path.join(worktreePath, "node_modules", "package.js"),
        "dependency",
      );
      assert.deepStrictEqual((yield* firstEntry(inventory)).removalBlockers, []);
      yield* fs.writeFileString(path.join(worktreePath, ".env"), "SECRET=keep");
      const entry = yield* firstEntry(inventory);
      assert.isTrue(entry.removalBlockers.some((blocker) => blocker.includes("ignored files")));
      const failure = yield* inventory
        .remove({
          projectId,
          path: entry.path,
          expectedHead: entry.head,
          expectedBranch: entry.branch,
        })
        .pipe(Effect.flip);
      assert.include(failure.detail, "ignored files");
      assert.isTrue(yield* fs.exists(path.join(worktreePath, ".env")));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps worktrees shared by active and archived threads", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, addThread } = yield* fixture;
      yield* addThread(thread(worktreePath));
      yield* addThread(
        thread(worktreePath, {
          id: ThreadId.make("thread-2"),
          archivedAt: DateTime.makeUnsafe(createdAt),
        }),
      );
      const entry = yield* firstEntry(inventory);
      assert.strictEqual(entry.threads.length, 2);
      assert.isTrue(entry.removalBlockers.some((blocker) => blocker.includes("Multiple threads")));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps preparing, running and waiting work", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, addThread, addRun, fs } = yield* fixture;
      yield* addThread(thread(worktreePath));
      for (const status of ["preparing", "running", "waiting"] as const) {
        yield* addRun(status);
        const entry = yield* firstEntry(inventory);
        assert.isTrue(entry.removalBlockers.some((blocker) => blocker.includes("agent session")));
        const failure = yield* inventory
          .remove({
            projectId,
            path: entry.path,
            expectedHead: entry.head,
            expectedBranch: entry.branch,
          })
          .pipe(Effect.flip);
        assert.include(failure.detail, "agent session");
        assert.isTrue(yield* fs.exists(worktreePath));
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps background work and pending approvals or user input until resolved", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, addThread, setRequest, setBackground } = yield* fixture;
      yield* addThread(thread(worktreePath));
      yield* setBackground(true);
      assert.isTrue(
        (yield* firstEntry(inventory)).removalBlockers.some((blocker) =>
          blocker.includes("agent session"),
        ),
      );
      yield* setBackground(false);
      assert.deepStrictEqual((yield* firstEntry(inventory)).removalBlockers, []);
      for (const kind of ["command", "user_input"] as const) {
        yield* setRequest(kind, "pending");
        assert.isTrue(
          (yield* firstEntry(inventory)).removalBlockers.some((blocker) =>
            blocker.includes("agent session"),
          ),
        );
        yield* setRequest(kind, "resolved");
        assert.deepStrictEqual((yield* firstEntry(inventory)).removalBlockers, []);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("protects a recent user message before a run adopts it", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, addThread, addMessage } = yield* fixture;
      yield* addThread(thread(worktreePath));
      yield* addMessage(yield* DateTime.now);
      assert.isTrue(
        (yield* firstEntry(inventory)).removalBlockers.some((blocker) =>
          blocker.includes("agent session"),
        ),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("ignores released sessions but protects a runtime still live after an error", () =>
    Effect.gen(function* () {
      const { inventory, addSession, liveSessionIds } = yield* fixture;
      yield* addSession("stopped");
      assert.deepStrictEqual((yield* firstEntry(inventory)).removalBlockers, []);
      yield* addSession("error");
      liveSessionIds.add(ProviderSessionId.make("session:outside"));
      assert.isTrue(
        (yield* firstEntry(inventory)).removalBlockers.some((blocker) =>
          blocker.includes("agent session"),
        ),
      );
      liveSessionIds.clear();
      assert.deepStrictEqual((yield* firstEntry(inventory)).removalBlockers, []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps live provider sessions that use an otherwise unlinked checkout", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, addSession, fs } = yield* fixture;
      const entry = yield* firstEntry(inventory);
      yield* addSession();
      const failure = yield* inventory
        .remove({
          projectId,
          path: entry.path,
          expectedHead: entry.head,
          expectedBranch: entry.branch,
        })
        .pipe(Effect.flip);
      assert.include(failure.detail, "agent session");
      assert.isTrue(yield* fs.exists(worktreePath));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps a queued turn before its provider session starts", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, addThread, addRun } = yield* fixture;
      yield* addThread(thread(worktreePath));
      yield* addRun("queued", true);
      assert.isTrue(
        (yield* firstEntry(inventory)).removalBlockers.some((blocker) =>
          blocker.includes("agent session"),
        ),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps running terminals even when their thread is not linked", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, terminalEntries, fs } = yield* fixture;
      terminalEntries.push({
        threadId: "unrelated",
        terminalId: "default",
        cwd: worktreePath,
        worktreePath: null,
        status: "running",
        pid: 1,
        exitCode: null,
        exitSignal: null,
        hasRunningSubprocess: false,
        label: "Shell",
        updatedAt: createdAt,
      });
      const entry = yield* firstEntry(inventory);
      const failure = yield* inventory
        .remove({
          projectId,
          path: entry.path,
          expectedHead: entry.head,
          expectedBranch: entry.branch,
        })
        .pipe(Effect.flip);
      assert.include(failure.detail, "terminal");
      assert.isTrue(yield* fs.exists(worktreePath));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps project roots and detached or locked worktrees", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, projects, git, addProject } = yield* fixture;
      yield* git(["worktree", "lock", worktreePath]);
      assert.isTrue(
        (yield* firstEntry(inventory)).removalBlockers.some((blocker) =>
          blocker.includes("locked"),
        ),
      );
      yield* git(["worktree", "unlock", worktreePath]);
      yield* git(["checkout", "--detach"], worktreePath);
      assert.isTrue(
        (yield* firstEntry(inventory)).removalBlockers.some((blocker) =>
          blocker.includes("detached HEAD"),
        ),
      );
      yield* addProject({
        ...projects[0]!,
        id: ProjectId.make("project-2"),
        workspaceRoot: worktreePath,
      });
      assert.isTrue(
        (yield* firstEntry(inventory)).removalBlockers.some((blocker) =>
          blocker.includes("workspace"),
        ),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects a main checkout and a path not registered to the project", () =>
    Effect.gen(function* () {
      const { inventory, cwd, fs, path } = yield* fixture;
      for (const target of [cwd, path.join(cwd, "unknown")]) {
        const failure = yield* inventory
          .remove({ projectId, path: target, expectedHead: "old", expectedBranch: "main" })
          .pipe(Effect.flip);
        assert.include(failure.detail, "no longer registered");
      }
      assert.isTrue(yield* fs.exists(cwd));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("shows external worktrees but never removes them", () =>
    Effect.gen(function* () {
      const { inventory, cwd, path, git, fs } = yield* fixture;
      const external = path.join(cwd, "external");
      yield* git(["worktree", "add", "-b", "external", external]);
      const entry = (yield* inventory.list({})).worktrees.find(
        (worktree) => worktree.branch === "external",
      )!;
      assert.isFalse(entry.managed);
      const failure = yield* inventory
        .remove({
          projectId,
          path: entry.path,
          expectedHead: entry.head,
          expectedBranch: entry.branch,
        })
        .pipe(Effect.flip);
      assert.include(failure.detail, "outside Paperplane");
      assert.isTrue(yield* fs.exists(external));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects a changed commit after confirmation", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, git, fs } = yield* fixture;
      const entry = yield* firstEntry(inventory);
      yield* git(["commit", "--allow-empty", "-m", "new work"], worktreePath);
      const failure = yield* inventory
        .remove({
          projectId,
          path: entry.path,
          expectedHead: entry.head,
          expectedBranch: entry.branch,
        })
        .pipe(Effect.flip);
      assert.include(failure.detail, "changed since");
      assert.isTrue(yield* fs.exists(worktreePath));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects a changed branch even when the commit stays the same", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, git, fs } = yield* fixture;
      const entry = yield* firstEntry(inventory);
      yield* git(["checkout", "-b", "other"], worktreePath);
      const failure = yield* inventory
        .remove({
          projectId,
          path: entry.path,
          expectedHead: entry.head,
          expectedBranch: entry.branch,
        })
        .pipe(Effect.flip);
      assert.include(failure.detail, "changed since");
      assert.isTrue(yield* fs.exists(worktreePath));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("estimates checkout files without following links into shared stores", () =>
    Effect.gen(function* () {
      const { inventory, worktreePath, fs, path, cwd } = yield* fixture;
      const external = path.join(cwd, "large-file");
      yield* fs.writeFileString(external, "x".repeat(5000));
      yield* fs.symlink(external, path.join(worktreePath, "linked-file"));
      const size = yield* inventory.measure({ projectId, path: worktreePath });
      assert.strictEqual(
        size.bytes,
        new TextEncoder().encode("example\nnode_modules/\n.env\nbuild/\n").length,
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it("returns unknown activity when no thread is linked", () => {
    assert.isNull(worktreeLastActivity([]));
  });
});
