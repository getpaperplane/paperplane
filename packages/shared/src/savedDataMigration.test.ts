// @effect-diagnostics nodeBuiltinImport:off - fixtures are isolated temp homes and repositories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  migrateDefaultHome,
  migrateRepositoryCheckpointRefs,
  rewriteSavedDataStep,
  rewriteStagedDatabase,
} from "./homeMigration.ts";
import { parseComposerContextHref } from "./composerContextReferences.ts";
import { parseAssistantCitationHref } from "./assistantCitations.ts";

let directory: string;
beforeEach(() => {
  directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "paperplane-saved-data-"));
});
afterEach(() => NodeFS.rmSync(directory, { recursive: true, force: true }));

it("rewrites events and every projection/attachment/PR JSON column without changing row counts", () => {
  const file = NodePath.join(directory, "statev2.sqlite");
  const db = new NodeSqlite.DatabaseSync(file);
  db.exec(`CREATE TABLE orchestration_events (id INTEGER PRIMARY KEY, payload_json TEXT, metadata_json TEXT);
    CREATE TABLE projection_thread_messages (text TEXT, attachments_json TEXT, context_json TEXT);
    CREATE TABLE projection_thread_pull_requests (url TEXT, snapshot_json TEXT, stack_json TEXT);
    CREATE TABLE orchestration_v2_projection_messages (payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_checkpoints (payload_json TEXT);
    CREATE TABLE "odd table" ("odd column" TEXT);
    CREATE TABLE without_rowid (id TEXT PRIMARY KEY, text TEXT) WITHOUT ROWID;`);
  const old = "[context](rove-context://v1/terminal/ctx_1)";
  db.prepare("INSERT INTO orchestration_events VALUES (1, ?, ?)").run(
    JSON.stringify({ text: old }),
    JSON.stringify({ href: "rove://new?prompt=hello" }),
  );
  db.prepare("INSERT INTO projection_thread_messages VALUES (?, ?, ?)").run(
    old,
    JSON.stringify([{ url: "rove-preview://attachment/a" }]),
    JSON.stringify({ text: old }),
  );
  db.prepare("INSERT INTO projection_thread_pull_requests VALUES (?, ?, ?)").run(
    "rove-thread://v1/thread-1",
    JSON.stringify({ body: old }),
    JSON.stringify([{ href: "rove-dev://app/" }]),
  );
  const citation = "rove-citation://v1/e/t/m?text=quote&start=0&end=5&prefix=&suffix=";
  db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES (?)").run(
    JSON.stringify({ text: citation }),
  );
  db.prepare("INSERT INTO orchestration_v2_projection_checkpoints VALUES (?)").run(
    '{"ref":"refs/rove/checkpoints/a"}',
  );
  db.prepare('INSERT INTO "odd table" VALUES (?)').run(old);
  db.prepare("INSERT INTO without_rowid VALUES ('one', ?)").run(old);
  db.close();
  const changes = rewriteStagedDatabase(file);
  expect(changes).toHaveLength(12);
  const result = new NodeSqlite.DatabaseSync(file);
  expect(result.prepare("SELECT payload_json FROM orchestration_events").get()?.payload_json).toBe(
    '{"text":"[context](paperplane-context://v1/terminal/ctx_1)"}',
  );
  expect(
    result.prepare("SELECT payload_json FROM orchestration_v2_projection_checkpoints").get()
      ?.payload_json,
  ).toBe('{"ref":"refs/paperplane/checkpoints/a"}');
  expect(parseComposerContextHref("paperplane-context://v1/terminal/ctx_1")).toEqual({
    kind: "terminal",
    contextId: "ctx_1",
  });
  expect(
    parseAssistantCitationHref(citation.replace("rove-citation:", "paperplane-citation:"))?.text,
  ).toBe("quote");
  for (const table of [
    "orchestration_events",
    "projection_thread_messages",
    "projection_thread_pull_requests",
    "orchestration_v2_projection_messages",
    "orchestration_v2_projection_checkpoints",
    "odd table",
    "without_rowid",
  ]) {
    expect(result.prepare(`SELECT count(*) AS n FROM "${table}"`).get()?.n).toBe(1);
  }
  result.close();
  expect(rewriteStagedDatabase(file)).toEqual([]);
});

it("converts app JSON on the staged home and leaves opaque files and source data alone", () => {
  const source = NodePath.join(directory, ".rove-code", "userdata");
  NodeFS.mkdirSync(NodePath.join(source, "secrets"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(source, "settings.json"),
    '{"providerKind":"rove_relay","roveHome":"/custom","themeId":"rove"}',
  );
  NodeFS.writeFileSync(NodePath.join(source, "secrets", "settings.json"), '{"owner":"rove"}');
  const original = NodeFS.readFileSync(NodePath.join(source, "settings.json"), "utf8");
  expect(migrateDefaultHome({ homeDirectory: directory, log: () => {} }).kind).toBe("migrated");
  const staged = NodePath.join(directory, ".paperplane");
  expect(
    JSON.parse(NodeFS.readFileSync(NodePath.join(staged, "userdata", "settings.json"), "utf8")),
  ).toEqual({ providerKind: "paperplane_relay", paperplaneHome: "/custom", themeId: "paperplane" });
  expect(NodeFS.readFileSync(NodePath.join(source, "settings.json"), "utf8")).toBe(original);
  expect(
    NodeFS.readFileSync(NodePath.join(staged, "userdata", "secrets", "settings.json"), "utf8"),
  ).toBe('{"owner":"rove"}');
  const before = NodeFS.readFileSync(NodePath.join(staged, "userdata", "settings.json"), "utf8");
  rewriteSavedDataStep.run(staged);
  expect(NodeFS.readFileSync(NodePath.join(staged, "userdata", "settings.json"), "utf8")).toBe(
    before,
  );
});

describe("lazy repository refs", () => {
  const git = (args: string[], cwd = directory) =>
    NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const seed = () => {
    git(["init", "--quiet"]);
    git(["config", "user.name", "Migration test"]);
    git(["config", "user.email", "migration@example.test"]);
    NodeFS.writeFileSync(NodePath.join(directory, "file"), "one");
    git(["add", "file"]);
    git(["commit", "--quiet", "-m", "one"]);
    return git(["rev-parse", "HEAD"]);
  };
  it("uses one shared completion marker across linked worktrees and moves every namespace", () => {
    const oid = seed();
    for (const suffix of [
      "checkpoints/a",
      "orchestration-v2/checkpoints/b",
      "review-guide/run/base",
      "pre-refresh",
    ])
      git(["update-ref", `refs/rove/${suffix}`, oid]);
    const linked = NodePath.join(directory, "linked");
    git(["worktree", "add", "--quiet", "--detach", linked]);
    expect(migrateRepositoryCheckpointRefs(linked)).toEqual({ converted: 4, conflicts: [] });
    expect(git(["for-each-ref", "--format=%(refname)", "refs/rove/"])).toBe("");
    expect(git(["rev-parse", "refs/paperplane/checkpoints/a"])).toBe(oid);
    expect(migrateRepositoryCheckpointRefs(directory)).toEqual({ converted: 0, conflicts: [] });
    expect(migrateRepositoryCheckpointRefs(linked)).toEqual({ converted: 0, conflicts: [] });
  });
  it("retains a symbolic ref and its target intact", () => {
    const oid = seed();
    git(["update-ref", "refs/rove/checkpoints/target", oid]);
    git(["symbolic-ref", "refs/rove/checkpoints/alias", "refs/rove/checkpoints/target"]);
    const result = migrateRepositoryCheckpointRefs(directory);
    expect(result.converted).toBe(0);
    expect(result.conflicts).toHaveLength(2);
    expect(git(["rev-parse", "refs/rove/checkpoints/alias"])).toBe(oid);
    expect(git(["rev-parse", "refs/rove/checkpoints/target"])).toBe(oid);
  });
  it("preserves conflicting values and safely deduplicates identical refs", () => {
    const first = seed();
    NodeFS.writeFileSync(NodePath.join(directory, "file"), "two");
    git(["commit", "--quiet", "-am", "two"]);
    const second = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/rove/checkpoints/conflict", first]);
    git(["update-ref", "refs/paperplane/checkpoints/conflict", second]);
    git(["update-ref", "refs/rove/checkpoints/same", first]);
    git(["update-ref", "refs/paperplane/checkpoints/same", first]);
    expect(migrateRepositoryCheckpointRefs(directory)).toEqual({
      converted: 1,
      conflicts: ["refs/rove/checkpoints/conflict -> refs/paperplane/checkpoints/conflict"],
    });
    expect(git(["rev-parse", "refs/rove/checkpoints/conflict"])).toBe(first);
    expect(git(["rev-parse", "refs/paperplane/checkpoints/conflict"])).toBe(second);
    expect(git(["for-each-ref", "--format=%(refname)", "refs/rove/checkpoints/same"])).toBe("");
    expect(git(["rev-parse", "refs/paperplane/checkpoints/same"])).toBe(first);
    expect(migrateRepositoryCheckpointRefs(directory)).toEqual({ converted: 0, conflicts: [] });
  });
  it("converges when two processes open linked worktrees together", async () => {
    const oid = seed();
    for (let index = 0; index < 20; index++)
      git(["update-ref", `refs/rove/checkpoints/${index}`, oid]);
    const linked = NodePath.join(directory, "linked");
    git(["worktree", "add", "--quiet", "--detach", linked]);
    const moduleUrl = new URL("./homeMigration.ts", import.meta.url).href;
    const migrate = (cwd: string) =>
      new Promise<string>((resolve, reject) => {
        NodeChildProcess.execFile(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { migrateRepositoryCheckpointRefs } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(migrateRepositoryCheckpointRefs(process.cwd())));`,
          ],
          { cwd, encoding: "utf8" },
          (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
        );
      });
    const results = await Promise.all([migrate(directory), migrate(linked)]);
    expect(results.sort()).toEqual([
      '{"converted":0,"conflicts":[]}',
      '{"converted":20,"conflicts":[]}',
    ]);
    expect(git(["for-each-ref", "--format=%(refname)", "refs/rove/"])).toBe("");
    const converted = git(["for-each-ref", "--format=%(objectname)", "refs/paperplane/"]).split(
      "\n",
    );
    expect(converted).toEqual(Array.from({ length: 20 }, () => oid));
  });
});
