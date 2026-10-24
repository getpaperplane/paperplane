// @effect-diagnostics nodeBuiltinImport:off - fixtures are isolated temp homes and repositories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  cleanupHomeMigrationGuard,
  HOME_MIGRATION_REPORT,
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

it("converts whole MCP identities in events, projections and approvals, not recorded prose or tool arguments", () => {
  const file = NodePath.join(directory, "statev2.sqlite");
  const db = new NodeSqlite.DatabaseSync(file);
  const tables = [
    "orchestration_events",
    "orchestration_v2_projection_turn_items",
    "orchestration_v2_projection_runtime_requests",
  ];
  const oldName = "mcp__rove__rove_thread_read";
  const item = {
    type: "dynamic_tool",
    toolName: oldName,
    title: oldName,
    label: oldName,
    text: `Use ${oldName}`,
    input: { toolName: oldName, server: "rove" },
    output: { toolName: oldName, matches: [oldName] },
    args: '{"toolName":"mcp__rove__rove_thread_read"}',
    toolData: { server: "rove", tool: "rove_thread_read" },
    suggestions: [{ rules: [{ toolName: oldName }] }],
    native: { type: "tool_use", name: "mcp__rove__preview_click" },
    foreign: { server: "other", tool: "rove_thread_read" },
    arguments: { toolName: oldName, server: "rove" },
    params: { toolName: oldName, server: "rove" },
    unrelated: { name: oldName, title: oldName, description: oldName, server: "rove" },
    unknown: { toolName: "mcp__rove__custom_tool" },
    retired: { toolName: "rove_thread_start" },
  };
  for (const table of tables) {
    db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, payload_json TEXT)`);
    db.prepare(`INSERT INTO ${table} VALUES (1, ?)`).run(JSON.stringify(item));
  }
  db.exec("CREATE TABLE old_tool_rows (tool_name TEXT, server_name TEXT, text TEXT)");
  db.prepare("INSERT INTO old_tool_rows VALUES (?, ?, ?)").run("rove_thread_read", "rove", oldName);
  db.close();
  expect(rewriteStagedDatabase(file)).toHaveLength(5);
  const result = new NodeSqlite.DatabaseSync(file);
  for (const table of tables) {
    const row = result.prepare(`SELECT payload_json FROM ${table}`).get();
    expect(JSON.parse(String(row?.payload_json))).toEqual({
      ...item,
      toolName: "mcp__paperplane__paperplane_thread_read",
      toolData: { server: "paperplane", tool: "paperplane_thread_read" },
      suggestions: [{ rules: [{ toolName: "mcp__paperplane__paperplane_thread_read" }] }],
      native: { type: "tool_use", name: "mcp__paperplane__preview_click" },
    });
    expect(result.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(1);
  }
  expect(result.prepare("SELECT * FROM old_tool_rows").get()).toEqual({
    tool_name: "paperplane_thread_read",
    server_name: "paperplane",
    text: oldName,
  });
  result.close();
  expect(rewriteStagedDatabase(file)).toEqual([]);
});

it.each([
  ["rove_thread_read", "paperplane_thread_read"],
  ["mcp__rove__rove_thread_read", "mcp__paperplane__paperplane_thread_read"],
  ["mcp__rove_code__preview_click", "mcp__paperplane__preview_click"],
  ["mcp__rove-code__delegate_task", "mcp__paperplane__delegate_task"],
  ["Rove-code.rove_project_clone", "mcp__paperplane__paperplane_project_clone"],
  ["rove_code/preview_open", "mcp__paperplane__preview_open"],
  ["rove · task_status", "mcp__paperplane__task_status"],
  ["mcp_rove_preview_click", "mcp__paperplane__preview_click"],
  [
    "rove-thread:v2:id_with_underscores_rove_thread_read",
    "paperplane-thread:v2:id_with_underscores_paperplane_thread_read",
  ],
  ["mcp__other__rove_thread_read", "mcp__other__rove_thread_read"],
  ["prefix mcp__rove__rove_thread_read suffix", "prefix mcp__rove__rove_thread_read suffix"],
  ["mcp__rove__rove_thread_read_extra", "mcp__rove__rove_thread_read_extra"],
  ["rove_thread_start", "rove_thread_start"],
])("converts only a recognized whole identifier: %s", (before, after) => {
  const file = NodePath.join(directory, "statev2.sqlite");
  const db = new NodeSqlite.DatabaseSync(file);
  db.exec("CREATE TABLE orchestration_events (payload_json TEXT)");
  db.prepare("INSERT INTO orchestration_events VALUES (?)").run(
    JSON.stringify({ toolName: before, text: before }),
  );
  db.close();
  rewriteStagedDatabase(file);
  const result = new NodeSqlite.DatabaseSync(file);
  expect(
    JSON.parse(
      String(result.prepare("SELECT payload_json FROM orchestration_events").get()?.payload_json),
    ),
  ).toEqual({ toolName: after, text: before });
  result.close();
  expect(rewriteStagedDatabase(file)).toEqual([]);
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
  it("moves every namespace once, starting from a linked worktree", async () => {
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
    expect(await migrateRepositoryCheckpointRefs(linked)).toEqual({ converted: 4, conflicts: [] });
    expect(git(["for-each-ref", "--format=%(refname)", "refs/rove/"])).toBe("");
    expect(git(["rev-parse", "refs/paperplane/checkpoints/a"])).toBe(oid);
    expect(await migrateRepositoryCheckpointRefs(directory)).toEqual({
      converted: 0,
      conflicts: [],
    });
    expect(await migrateRepositoryCheckpointRefs(linked)).toEqual({ converted: 0, conflicts: [] });
  });
  it("retains a symbolic ref and its target intact", async () => {
    const oid = seed();
    git(["update-ref", "refs/rove/checkpoints/target", oid]);
    git(["symbolic-ref", "refs/rove/checkpoints/alias", "refs/rove/checkpoints/target"]);
    const result = await migrateRepositoryCheckpointRefs(directory);
    expect(result.converted).toBe(0);
    expect(result.conflicts).toHaveLength(2);
    expect(git(["rev-parse", "refs/rove/checkpoints/alias"])).toBe(oid);
    expect(git(["rev-parse", "refs/rove/checkpoints/target"])).toBe(oid);
  });
  it("preserves conflicting values and safely deduplicates identical refs", async () => {
    const first = seed();
    NodeFS.writeFileSync(NodePath.join(directory, "file"), "two");
    git(["commit", "--quiet", "-am", "two"]);
    const second = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/rove/checkpoints/conflict", first]);
    git(["update-ref", "refs/paperplane/checkpoints/conflict", second]);
    git(["update-ref", "refs/rove/checkpoints/same", first]);
    git(["update-ref", "refs/paperplane/checkpoints/same", first]);
    expect(await migrateRepositoryCheckpointRefs(directory)).toEqual({
      converted: 1,
      conflicts: ["refs/rove/checkpoints/conflict -> refs/paperplane/checkpoints/conflict"],
    });
    expect(git(["rev-parse", "refs/rove/checkpoints/conflict"])).toBe(first);
    expect(git(["rev-parse", "refs/paperplane/checkpoints/conflict"])).toBe(second);
    expect(git(["for-each-ref", "--format=%(refname)", "refs/rove/checkpoints/same"])).toBe("");
    expect(git(["rev-parse", "refs/paperplane/checkpoints/same"])).toBe(first);
    expect(await migrateRepositoryCheckpointRefs(directory)).toEqual({
      converted: 0,
      conflicts: [],
    });
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
            `import { migrateRepositoryCheckpointRefs } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await migrateRepositoryCheckpointRefs(process.cwd())));`,
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

it("retires the guard only on a later start with a committed report, and respects an active owner", () => {
  NodeFS.mkdirSync(NodePath.join(directory, ".rove-code", "userdata"), { recursive: true });
  expect(migrateDefaultHome({ homeDirectory: directory, log: () => {} }).kind).toBe("migrated");
  const guardPath = NodePath.join(directory, ".paperplane-migration.sqlite");
  expect(NodeFS.existsSync(guardPath)).toBe(true);
  const owner = new NodeSqlite.DatabaseSync(guardPath);
  owner.exec("BEGIN EXCLUSIVE");
  cleanupHomeMigrationGuard(directory);
  expect(NodeFS.existsSync(guardPath)).toBe(true);
  owner.close();
  expect(NodeFS.existsSync(NodePath.join(directory, ".paperplane", HOME_MIGRATION_REPORT))).toBe(
    true,
  );
  expect(migrateDefaultHome({ homeDirectory: directory }).kind).toBe("skipped");
  expect(NodeFS.existsSync(guardPath)).toBe(false);
  cleanupHomeMigrationGuard(directory);
});

it("keeps the shared guard until there is a valid committed report", () => {
  const guardPath = NodePath.join(directory, ".paperplane-migration.sqlite");
  const guard = new NodeSqlite.DatabaseSync(guardPath);
  guard.close();
  cleanupHomeMigrationGuard(directory);
  expect(NodeFS.existsSync(guardPath)).toBe(true);
  const destination = NodePath.join(directory, ".paperplane");
  NodeFS.mkdirSync(destination);
  NodeFS.writeFileSync(NodePath.join(destination, HOME_MIGRATION_REPORT), "{}");
  expect(() => cleanupHomeMigrationGuard(directory)).toThrow();
  expect(NodeFS.existsSync(guardPath)).toBe(true);
});
