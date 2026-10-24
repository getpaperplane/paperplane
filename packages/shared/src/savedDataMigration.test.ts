// @effect-diagnostics nodeBuiltinImport:off - fixtures are isolated temp homes and repositories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  migrateDefaultHome,
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
