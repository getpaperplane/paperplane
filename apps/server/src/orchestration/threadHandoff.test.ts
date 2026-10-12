import {
  EnvironmentId,
  ThreadId,
  type ExecutionEnvironmentDescriptor,
  type RepositoryIdentity,
} from "@rove-code/contracts";
import { it, assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { GitVcsDriver, type GitStatusDetails } from "../vcs/GitVcsDriver.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";
import { exportThreadHandoff } from "./threadHandoff.ts";

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const threadId = ThreadId.make("handoff-source");
const sha = "a".repeat(40);
const identity: RepositoryIdentity = {
  canonicalKey: "github.com/acme/repo",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "https://github.com/acme/repo.git",
  },
};
const environment: ExecutionEnvironmentDescriptor = {
  environmentId: EnvironmentId.make("source"),
  label: "Source",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "test",
  capabilities: { repositoryIdentity: true },
};
const clean: GitStatusDetails = {
  isRepo: true,
  hasOriginRemote: true,
  isDefaultBranch: false,
  branch: "feature/handoff",
  upstreamRef: "origin/feature/handoff",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
};

function testLayer(options: { dirty?: boolean; remoteSha?: string; changedHead?: boolean } = {}) {
  let heads = 0;
  return OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(
      Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(identity) }),
    ),
    Layer.provideMerge(
      Layer.mock(GitVcsDriver, {
        statusDetailsLocal: () =>
          Effect.succeed({ ...clean, hasWorkingTreeChanges: options.dirty === true }),
        resolveCommit: () =>
          Effect.sync(() => ({
            commitSha: options.changedHead && ++heads > 1 ? "c".repeat(40) : sha,
          })),
        fetchRemote: () => Effect.void,
        resolveRemoteTrackingCommit: () =>
          Effect.succeed({
            commitSha: options.remoteSha ?? sha,
            remoteRefName: "refs/remotes/origin/feature/handoff",
          }),
      }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );
}

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('project', 'Project', '/repo', '[]', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, branch, created_at, updated_at) VALUES (${threadId}, 'project', 'Source thread', '{"instanceId":"codex","model":"fixture"}', 'approval-required', 'default', 'feature/handoff', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`;
  yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, attachments_json, is_streaming, created_at, updated_at) VALUES ('original', ${threadId}, NULL, 'user', 'Keep the original constraints intact.', '[]', 0, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`;
});

it.effect(
  "exports authoritative workspace identity and intact history without starting a provider",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const result = yield* exportThreadHandoff({ threadId }, environment);
      assert.strictEqual(result.branch, "feature/handoff");
      assert.strictEqual(result.commitSha, sha);
      assert.strictEqual(result.repositoryKey, identity.canonicalKey);
      assert.strictEqual(result.sourceEnvironmentId, environment.environmentId);
      assert.strictEqual(
        result.items.find((item) => item.id === "original")?.text,
        "Keep the original constraints intact.",
      );
      assert.strictEqual(result.omittedItems, 0);
    }).pipe(Effect.provide(testLayer())),
);

it.effect("carries factual command outcomes without native state or permission objects", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const payload = yield* encodePayload({
      command: "vp test run fixture.test.ts",
      exitCode: 1,
      stdout: "Two tests failed.",
      status: "completed",
      nativeReasoning: "private native state",
      permissionGrant: "approved",
    });
    yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at) VALUES ('test-outcome', ${threadId}, NULL, 'info', 'tool.completed', 'Ran tests', ${payload}, 1, '2026-09-01T00:00:00Z')`;
    const handoff = yield* exportThreadHandoff({ threadId }, environment);
    const outcome = handoff.items.find((item) => item.id === "test-outcome");
    assert(outcome);
    assert.match(outcome.text, /Two tests failed/);
    assert.match(outcome.text, /"exitCode":1/);
    assert(!outcome.text.includes("nativeReasoning"));
    assert(!outcome.text.includes("permissionGrant"));
  }).pipe(Effect.provide(testLayer())),
);

it.effect("refuses dirty workspaces", () =>
  Effect.gen(function* () {
    yield* seed;
    const error = yield* Effect.flip(exportThreadHandoff({ threadId }, environment));
    assert.strictEqual(error.kind, "workspace");
    assert.match(error.message, /uncommitted/);
  }).pipe(Effect.provide(testLayer({ dirty: true }))),
);

it.effect("refuses a shared branch at a different commit", () =>
  Effect.gen(function* () {
    yield* seed;
    const error = yield* Effect.flip(exportThreadHandoff({ threadId }, environment));
    assert.strictEqual(error.kind, "workspace");
    assert.match(error.message, /remote currently differs/);
  }).pipe(Effect.provide(testLayer({ remoteSha: "b".repeat(40) }))),
);

it.effect("rejects workspace changes during export", () =>
  Effect.gen(function* () {
    yield* seed;
    const error = yield* Effect.flip(exportThreadHandoff({ threadId }, environment));
    assert.strictEqual(error.kind, "workspace");
    assert.match(error.message, /source changed/);
  }).pipe(Effect.provide(testLayer({ changedHead: true }))),
);

it.effect("missing history requires explicit code-only consent", () =>
  Effect.gen(function* () {
    yield* seed;
    const query = yield* ProjectionSnapshotQuery;
    const missingHistory = {
      ...query,
      getThreadDetailSnapshot: () => Effect.succeedNone,
    };
    const error = yield* exportThreadHandoff({ threadId }, environment).pipe(
      Effect.provideService(ProjectionSnapshotQuery, missingHistory),
      Effect.flip,
    );
    assert.strictEqual(error.kind, "history");
    const result = yield* exportThreadHandoff({ threadId, codeOnly: true }, environment).pipe(
      Effect.provideService(ProjectionSnapshotQuery, missingHistory),
    );
    assert.strictEqual(result.codeOnly, true);
    assert.deepStrictEqual(result.items, []);
    assert.strictEqual(result.commitSha, sha);
  }).pipe(Effect.provide(testLayer())),
);

it.effect("rejects a source that becomes busy even if its timestamp is unchanged", () =>
  Effect.gen(function* () {
    yield* seed;
    const query = yield* ProjectionSnapshotQuery;
    const original = yield* query.getThreadShellById(threadId);
    assert(Option.isSome(original));
    let reads = 0;
    const error = yield* exportThreadHandoff({ threadId }, environment).pipe(
      Effect.provideService(ProjectionSnapshotQuery, {
        ...query,
        getThreadShellById: () =>
          Effect.sync(() =>
            Option.some({
              ...original.value,
              backgroundLiveness: ++reads > 1 ? ("working" as const) : null,
            }),
          ),
      }),
      Effect.flip,
    );
    assert.strictEqual(error.kind, "workspace");
    assert.match(error.message, /source changed/);
  }).pipe(Effect.provide(testLayer())),
);

it.effect("refuses a live source turn", () =>
  Effect.gen(function* () {
    yield* seed;
    const query = yield* ProjectionSnapshotQuery;
    const original = yield* query.getThreadShellById(threadId);
    assert(Option.isSome(original));
    const error = yield* exportThreadHandoff({ threadId }, environment).pipe(
      Effect.provideService(ProjectionSnapshotQuery, {
        ...query,
        getThreadShellById: () =>
          Effect.succeed(
            Option.some({ ...original.value, backgroundLiveness: "working" as const }),
          ),
      }),
      Effect.flip,
    );
    assert.strictEqual(error.kind, "workspace");
    assert.match(error.message, /finish/);
  }).pipe(Effect.provide(testLayer())),
);
