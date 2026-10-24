// Reproducible logical idle-work benchmark: vp test run apps/server/src/scheduling/ServerIdle.test.ts
// PAPERPLANE_IDLE_THREADS controls fixture size (default 5000). Counts actual SQL statements,
// scheduler source executions, and fake host-summary reads; excludes startup and seeding.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderKind,
  ThreadId,
  OrchestrationV2AppThread,
  type PullRequestSummary,
} from "@getpaperplane/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as TestClock from "effect/testing/TestClock";
import { layerPolicy } from "../background/testkit.ts";
import * as GitManager from "../git/GitManager.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as PullRequestSync from "../orchestration-v2/PullRequestSyncReactor.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as UsageRecovery from "../orchestration-v2/UsageLimitRecoveryWorker.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Settings from "../serverSettings.ts";
import * as Scheduler from "./Scheduler.ts";

it.effect("bounds one simulated hour of idle work with retained threads and an open PR", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const iso = DateTime.formatIso(now);
    const id = ThreadId.make("thread:idle:pr");
    const projectId = ProjectId.make("project:idle");
    const summary: PullRequestSummary = {
      provider: SourceControlProviderKind.make("github"),
      projectId,
      repository: "owner/repo",
      number: 1,
      url: "https://github.com/owner/repo/pull/1",
      state: "open",
      title: "Idle PR",
      headBranch: "feature",
      baseBranch: "main",
      updatedAt: iso,
      isDraft: false,
      stack: null,
    };
    const thread: OrchestrationV2AppThread = {
      id,
      projectId,
      title: "Idle thread",
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "web",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
      pullRequests: [
        {
          host: "github.com",
          repository: summary.repository,
          number: summary.number,
          url: summary.url,
          source: "manual",
          linkedAt: iso,
          stack: null,
          snapshot: {
            state: "open",
            title: summary.title,
            headBranch: summary.headBranch,
            baseBranch: summary.baseBranch,
            isDraft: false,
            updatedAt: iso,
            syncedAt: iso,
            closedAt: null,
            mergedAt: null,
          },
        },
      ],
    };
    yield* store.apply({
      id: EventId.make("event:idle"),
      type: "thread.created",
      threadId: id,
      occurredAt: now,
      payload: thread,
    });
    const n = Number(process.env.PAPERPLANE_IDLE_THREADS ?? 5000);
    assert.isTrue(Number.isInteger(n) && n > 0 && n <= 100000);
    const payload = yield* Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2AppThread))({
      ...thread,
      pullRequests: [],
    });
    yield* sql`
      WITH RECURSIVE fixture(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM fixture WHERE n < ${n})
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      SELECT 'thread:idle:' || n, ${projectId}, 'Dormant', 'codex', 'codex', 'full-access', 'default', ${iso}, ${iso},
        json_set(${payload}, '$.id', 'thread:idle:' || n, '$.lineage.rootThreadId', 'thread:idle:' || n) FROM fixture
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, completed_at, payload_json)
      SELECT 'run:' || thread_id, thread_id, 1, 'codex', 'codex', 'completed', ${iso}, ${iso}, ${JSON.stringify({ startedAt: iso, rootNodeId: null })}
      FROM orchestration_v2_projection_threads
    `;
    const counts = yield* Ref.make({ queries: 0, schedulerPasses: 0, githubCalls: 0 });
    const increment = (key: "queries" | "schedulerPasses" | "githubCalls") =>
      Ref.update(counts, (value) => ({ ...value, [key]: value[key] + 1 }));
    const counter: Statement.Transformer = (statement) =>
      increment("queries").pipe(Effect.as(statement));
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      layerPolicy(false),
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.empty,
        dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(ThreadManagement.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        streamChanges: Stream.empty,
      }),
      Layer.mock(GitManager.GitManager)({
        subscribePullRequestStateChanges: Effect.succeed(Stream.empty),
      }),
      Layer.mock(PullRequestService.PullRequestService)({
        summary: () => increment("githubCalls").pipe(Effect.as(summary)),
        subscribeStateChanges: Effect.succeed(Stream.empty),
      }),
    );
    const workers = Layer.mergeAll(
      ScheduledTasks.layer,
      UsageRecovery.layer,
      PullRequestSync.layer,
    ).pipe(Layer.provide(dependencies), Layer.provideMerge(Scheduler.layer));
    yield* Effect.gen(function* () {
      const scheduler = yield* Scheduler.Scheduler;
      yield* scheduler.register("idle-benchmark-counter", increment("schedulerPasses"));
      const sync = yield* PullRequestSync.PullRequestSyncReactor;
      yield* sync.start();
      // Adjust(0) drains startup fibers and the worker; reset logical counts after initialization.
      yield* TestClock.adjust(0);
      yield* sync.drain;
      yield* Ref.set(counts, { queries: 0, schedulerPasses: 0, githubCalls: 0 });
      yield* TestClock.adjust("1 hour");
      yield* sync.drain;
      const measured = yield* Ref.get(counts);
      const result = JSON.stringify({ threads: n, simulatedHours: 1, ...measured });
      yield* Effect.logInfo("SERVER_IDLE", result);
      if (process.env.PAPERPLANE_IDLE_RESULT_PATH !== undefined) {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(process.env.PAPERPLANE_IDLE_RESULT_PATH, result);
      }
      if (process.env.PAPERPLANE_IDLE_BASELINE !== "1") {
        assert.equal(measured.schedulerPasses, 4);
        assert.equal(measured.githubCalls, 4);
        assert.equal(measured.queries, 16);
      }
    }).pipe(Effect.provide(workers), Effect.provideService(Statement.CurrentTransformer, counter));
  }).pipe(
    Effect.provide(
      ProjectionStore.layer.pipe(
        Layer.provideMerge(Sqlite.layerMemory),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
