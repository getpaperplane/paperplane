// @effect-diagnostics nodeBuiltinImport:off - all migration inputs are isolated temporary directories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  HOME_MIGRATION_REPORT,
  oldServiceStopInstruction,
  migrateDefaultHome,
  publishHomeMigration,
  type HomeMigrationStep,
} from "./homeMigration.ts";

let homeDirectory: string;
let source: string;
let destination: string;
const log = () => {};

beforeEach(() => {
  homeDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "paperplane-home-migration-"));
  source = NodePath.join(homeDirectory, ".rove-code");
  destination = NodePath.join(homeDirectory, ".paperplane");
});
afterEach(() => NodeFS.rmSync(homeDirectory, { recursive: true, force: true }));

function seed() {
  NodeFS.mkdirSync(NodePath.join(source, "userdata", "secrets"), { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(NodePath.join(source, "userdata", "settings.json"), '{"theme":"dark"}');
  NodeFS.writeFileSync(NodePath.join(source, "userdata", "secrets", "token"), "credential", {
    mode: 0o600,
  });
  const database = new NodeSqlite.DatabaseSync(NodePath.join(source, "userdata", "statev2.sqlite"));
  database.exec("CREATE TABLE messages (text TEXT); INSERT INTO messages VALUES ('hello');");
  database.close();
}

function migrate(steps?: readonly HomeMigrationStep[]) {
  return migrateDefaultHome({ homeDirectory, log, steps });
}

function rows(path = NodePath.join(destination, "userdata", "statev2.sqlite")) {
  const db = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare("SELECT text FROM messages ORDER BY rowid")
      .all()
      .map((row) => row.text);
  } finally {
    db.close();
  }
}

interface SnapshotEntry {
  name: string;
  mode: number;
  contents: Buffer | string | SnapshotEntry[];
}

function snapshot(root: string): SnapshotEntry[] {
  return NodeFS.readdirSync(root)
    .sort()
    .map((name) => {
      const path = NodePath.join(root, name);
      const stat = NodeFS.lstatSync(path);
      return {
        name,
        mode: stat.mode,
        contents: stat.isDirectory()
          ? snapshot(path)
          : stat.isSymbolicLink()
            ? NodeFS.readlinkSync(path)
            : NodeFS.readFileSync(path),
      };
    });
}

it.each([
  ["linux", "systemctl --user disable --now rove.service"],
  [
    "darwin",
    "launchctl bootout --wait gui/$(id -u)/io.github.hafiezul.rove.service && launchctl disable",
  ],
  ["win32", "close the terminal running `rove serve`"],
] as const)("gives actionable old-service recovery on %s", (platform, command) => {
  expect(oldServiceStopInstruction(platform)).toContain(command);
});

describe("default home migration", () => {
  it("atomically refuses an empty destination at the native publication boundary", () => {
    const staged = NodePath.join(homeDirectory, "staged-数据");
    NodeFS.mkdirSync(staged);
    NodeFS.writeFileSync(NodePath.join(staged, "data"), "complete snapshot");
    NodeFS.mkdirSync(destination);
    const inode = NodeFS.statSync(destination).ino;
    expect(publishHomeMigration(staged, destination)).toBe("destination-exists");
    expect(NodeFS.statSync(destination).ino).toBe(inode);
    expect(NodeFS.readdirSync(destination)).toEqual([]);
    expect(NodeFS.readFileSync(NodePath.join(staged, "data"), "utf8")).toBe("complete snapshot");
    NodeFS.rmdirSync(destination);
    expect(publishHomeMigration(staged, destination)).toBe("published");
    expect(NodeFS.readFileSync(NodePath.join(destination, "data"), "utf8")).toBe(
      "complete snapshot",
    );
  });
  it("works when the parent Node invocation uses --input-type=module", () => {
    seed();
    const child = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { migrateDefaultHome } = await import(process.argv[2]);
       const result = migrateDefaultHome({ homeDirectory: process.argv[1], log: () => {} });
       if (result.kind !== 'migrated') throw new Error('migration did not run');`,
        homeDirectory,
        new URL("./homeMigration.ts", import.meta.url).href,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(rows()).toEqual(["hello"]);
  });
  it("copies state on first start, reports the result, and does nothing on second start", () => {
    seed();
    const messages: string[] = [];
    const outcome = migrateDefaultHome({ homeDirectory, log: (message) => messages.push(message) });
    expect(outcome.kind).toBe("migrated");
    expect(rows()).toEqual(["hello"]);
    expect(
      NodeFS.readFileSync(NodePath.join(destination, "userdata", "settings.json"), "utf8"),
    ).toBe('{"theme":"dark"}');
    expect(
      JSON.parse(NodeFS.readFileSync(NodePath.join(destination, HOME_MIGRATION_REPORT), "utf8")),
    ).toMatchObject({
      source,
      destination,
      copied: ["userdata"],
      databases: ["userdata/statev2.sqlite"],
      steps: ["copy-user-state", "paperplane-saved-data", "stage-desktop-secrets"],
    });
    expect(messages[0]).toContain("The old home is kept as a backup");
    const before = snapshot(destination);
    expect(migrate()).toEqual({ kind: "skipped", reason: "destination-exists" });
    expect(snapshot(destination)).toEqual(before);
  });

  it("quarantines desktop ciphertext in the staged home, including when the CLI migrates first", () => {
    seed();
    const files = ["connection-catalog.json", "saved-environments.json", "clerk-tokens.json"];
    for (const name of files)
      NodeFS.writeFileSync(
        NodePath.join(source, "userdata", name),
        '{"encrypted":"old-identity-bytes"}',
      );
    const before = snapshot(source);
    expect(migrate().kind).toBe("migrated");
    expect(snapshot(source)).toEqual(before);
    for (const name of files) {
      expect(NodeFS.existsSync(NodePath.join(destination, "userdata", name))).toBe(false);
      expect(
        JSON.parse(
          NodeFS.readFileSync(
            NodePath.join(destination, "userdata", "desktop-name-migration", "input", name),
            "utf8",
          ),
        ),
      ).toEqual({ encrypted: "old-identity-bytes" });
    }
    const after = snapshot(destination);
    expect(migrate().kind).toBe("skipped");
    expect(snapshot(destination)).toEqual(after);
  });

  it.each(["file", "symlink"])("never replaces an existing %s destination", (kind) => {
    seed();
    if (kind === "file") NodeFS.writeFileSync(destination, "keep");
    else if (kind === "symlink")
      NodeFS.symlinkSync(NodePath.join(homeDirectory, "missing"), destination);
    const before = NodeFS.lstatSync(destination);
    expect(migrate()).toEqual({ kind: "skipped", reason: "destination-exists" });
    expect(NodeFS.lstatSync(destination).ino).toBe(before.ino);
    expect(NodeFS.existsSync(NodePath.join(homeDirectory, ".paperplane-migration.sqlite"))).toBe(
      false,
    );
  });

  it.each(["", "runtime", "ssh-launch", "bin", "tools", "caches", "wsl-runtime", "device"])(
    "migrates into a home pre-created with %s and keeps its contents",
    (entry) => {
      seed();
      NodeFS.mkdirSync(NodePath.join(destination, entry), { recursive: true });
      if (entry) {
        NodeFS.writeFileSync(NodePath.join(destination, entry, "new"), "keep new state");
        NodeFS.mkdirSync(NodePath.join(source, entry));
        NodeFS.writeFileSync(NodePath.join(source, entry, "old"), "obsolete cache or runner");
      }
      const before = entry ? snapshot(NodePath.join(destination, entry)) : [];
      expect(migrate().kind).toBe("migrated");
      expect(rows()).toEqual(["hello"]);
      if (entry) expect(snapshot(NodePath.join(destination, entry))).toEqual(before);
      const complete = snapshot(destination);
      expect(migrate()).toEqual({ kind: "skipped", reason: "destination-exists" });
      expect(snapshot(destination)).toEqual(complete);
    },
  );

  it("records that the old home was not migrated when the destination already has userdata", () => {
    seed();
    NodeFS.mkdirSync(NodePath.join(destination, "userdata"), { recursive: true });
    const db = new NodeSqlite.DatabaseSync(
      NodePath.join(destination, "userdata", "statev2.sqlite"),
    );
    db.exec("CREATE TABLE messages (text TEXT); INSERT INTO messages VALUES ('new install');");
    db.close();
    const before = snapshot(NodePath.join(destination, "userdata"));
    const outcome = migrate();
    expect(outcome).toMatchObject({
      kind: "skipped",
      reason: "destination-userdata-exists",
      report: { status: "skipped", source, destination, copied: [], databases: [] },
    });
    expect(
      JSON.parse(NodeFS.readFileSync(NodePath.join(destination, HOME_MIGRATION_REPORT), "utf8")),
    ).toMatchObject({
      status: "skipped",
      reason: "destination-userdata-exists",
      source,
      destination,
    });
    expect(rows()).toEqual(["new install"]);
    expect(snapshot(NodePath.join(destination, "userdata"))).toEqual(before);
    const complete = snapshot(destination);
    expect(migrate()).toEqual({ kind: "skipped", reason: "destination-exists" });
    expect(snapshot(destination)).toEqual(complete);
  });

  it("keeps existing unknown entries and records only entries actually copied", () => {
    seed();
    for (const root of [source, destination]) {
      NodeFS.mkdirSync(NodePath.join(root, "future-state"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(root, "future-state", "keep"), root);
    }
    const outcome = migrate();
    expect(outcome).toMatchObject({
      kind: "migrated",
      report: {
        copied: ["userdata"],
        skipped: [{ path: "future-state", reason: expect.stringContaining("left untouched") }],
      },
    });
    expect(NodeFS.readFileSync(NodePath.join(destination, "future-state", "keep"), "utf8")).toBe(
      destination,
    );
    expect(rows()).toEqual(["hello"]);
  });

  // Instrument the real native rename in a separate process. Exiting just
  // after it succeeds leaves both SQLite locks and the stage as a crash would.
  function publishInChild(interruptAt: string) {
    return NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import fs from 'node:fs';
      import path from 'node:path';
      import { createRequire } from 'node:module';
      const migrationUrl = process.argv[2];
      const ffi = createRequire(migrationUrl)('ffi-rs');
      const nativeLoad = ffi.load;
      const destination = path.join(process.argv[1], '.paperplane');
      ffi.load = function(options) {
        const target = options.paramsValue[options.paramsValue.length - 2];
        const name = path.basename(String(target));
        if (String(target).startsWith(destination + path.sep)) {
          if (fs.existsSync(path.join(destination, 'home-migration.json'))) throw Error('report published early');
          if (name === 'home-migration.json' && (!fs.existsSync(path.join(destination, 'userdata', 'statev2.sqlite')) || !fs.existsSync(path.join(destination, 'extra')))) throw Error('incomplete publication');
        }
        const result = nativeLoad(options);
        if (String(target).startsWith(destination + path.sep) && !fs.existsSync(options.paramsValue[options.paramsValue.length - 4] ?? options.paramsValue[0])) {
          process.stdout.write(name + '\\n');
          if (name === process.argv[3]) process.exit(37);
        }
        return result;
      };
      const { migrateDefaultHome } = await import(migrationUrl);
      migrateDefaultHome({ homeDirectory: process.argv[1], log: () => {} });`,
        homeDirectory,
        new URL("./homeMigration.ts", import.meta.url).href,
        interruptAt,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
  }

  it("publishes the report only after every entry in a pre-created home", () => {
    seed();
    NodeFS.mkdirSync(destination);
    NodeFS.writeFileSync(NodePath.join(source, "extra"), "more user state");
    const child = publishInChild("");
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim().split("\n")).toEqual(["userdata", "extra", HOME_MIGRATION_REPORT]);
    expect(rows()).toEqual(["hello"]);
  });

  it.each(["userdata", "extra"])(
    "resumes after a crash publishing %s without recopying or overwriting newer data",
    (interruptAt) => {
      seed();
      NodeFS.mkdirSync(NodePath.join(destination, "runtime"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(source, "extra"), "prepared state");
      NodeFS.writeFileSync(NodePath.join(source, "last"), "publish on retry");
      const child = publishInChild(interruptAt);
      expect(child.status, child.stderr).toBe(37);
      expect(NodeFS.existsSync(NodePath.join(destination, HOME_MIGRATION_REPORT))).toBe(false);
      const db = new NodeSqlite.DatabaseSync(
        NodePath.join(destination, "userdata", "statev2.sqlite"),
      );
      db.exec("INSERT INTO messages VALUES ('new Paperplane write');");
      db.close();
      // The retry must use the prepared snapshot, even if the source changes.
      NodeFS.writeFileSync(NodePath.join(source, "extra"), "changed after snapshot");
      NodeFS.writeFileSync(NodePath.join(destination, "last"), "new file before retry");
      if (interruptAt === "extra")
        NodeFS.writeFileSync(NodePath.join(destination, "extra"), "new Paperplane file");
      expect(
        migrate([
          {
            name: "must-not-run-again",
            run: () => {
              throw new Error("recopied");
            },
          },
        ]).kind,
      ).toBe("migrated");
      expect(rows()).toEqual(["hello", "new Paperplane write"]);
      expect(NodeFS.readFileSync(NodePath.join(destination, "extra"), "utf8")).toBe(
        interruptAt === "extra" ? "new Paperplane file" : "prepared state",
      );
      expect(NodeFS.readFileSync(NodePath.join(destination, "last"), "utf8")).toBe(
        "new file before retry",
      );
      expect(
        JSON.parse(NodeFS.readFileSync(NodePath.join(destination, HOME_MIGRATION_REPORT), "utf8")),
      ).toMatchObject({
        status: "migrated",
        copied: ["extra", "userdata"],
        skipped: [{ path: "last", reason: expect.stringContaining("left untouched") }],
      });
      expect(NodeFS.readdirSync(destination).sort()).toEqual(
        ["extra", HOME_MIGRATION_REPORT, "last", "runtime", "userdata"].sort(),
      );
      expect(NodeFS.existsSync(NodePath.join(homeDirectory, ".paperplane-migration-stage"))).toBe(
        false,
      );
      expect(migrate()).toEqual({ kind: "skipped", reason: "destination-exists" });
    },
  );

  it.each(["/explicit/home", "~/.custom", ".paperplane"])(
    "skips an explicit home %s",
    (explicitHome) => {
      seed();
      expect(migrateDefaultHome({ homeDirectory, explicitHome, log })).toEqual({
        kind: "skipped",
        reason: "explicit-home",
      });
      expect(NodeFS.existsSync(destination)).toBe(false);
    },
  );

  it("skips disposable development homes", () => {
    seed();
    expect(migrateDefaultHome({ homeDirectory, development: true, log })).toEqual({
      kind: "skipped",
      reason: "development",
    });
    expect(NodeFS.existsSync(destination)).toBe(false);
  });

  it("does nothing when the old home is missing", () => {
    expect(migrate()).toEqual({ kind: "skipped", reason: "source-missing" });
    expect(NodeFS.readdirSync(homeDirectory)).toEqual([]);
  });

  it("backs up rows present only in the WAL, including a database without a SQLite extension", async () => {
    seed();
    const path = NodePath.join(source, "userdata", "statev2.sqlite");
    // The old server is another process. Keep its WAL open without checkpointing.
    const writer = NodeChildProcess.spawn(
      process.execPath,
      [
        "-e",
        `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO messages VALUES ('only in WAL');");
      process.stdout.write('ready');
      process.stdin.resume();
      process.stdin.once('end', () => db.close());
    `,
        path,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    await NodeEvents.EventEmitter.once(writer.stdout, "data");
    expect(NodeFS.readFileSync(path).includes(Buffer.from("only in WAL"))).toBe(false);
    expect(NodeFS.statSync(`${path}-wal`).size).toBeGreaterThan(0);
    const other = new NodeSqlite.DatabaseSync(NodePath.join(source, "userdata", "browser-data"));
    other.exec("CREATE TABLE messages (text TEXT); INSERT INTO messages VALUES ('browser');");
    other.close();
    try {
      const before = snapshot(source);
      migrate();
      expect(snapshot(source)).toEqual(before);
      expect(NodeFS.existsSync(NodePath.join(destination, "userdata", "statev2.sqlite-wal"))).toBe(
        false,
      );
      expect(rows()).toEqual(["hello", "only in WAL"]);
      expect(rows(NodePath.join(destination, "userdata", "browser-data"))).toEqual(["browser"]);
    } finally {
      const exited = NodeEvents.EventEmitter.once(writer, "exit");
      writer.stdin.end();
      await exited;
    }
  });

  it("skips rebuildable state and copies user work and unknown entries", () => {
    seed();
    const skipped = [
      "worktrees",
      "scratch",
      "projects",
      "runtime",
      "caches",
      "dev",
      "tools",
      "bin",
      "ssh-launch",
      "wsl-runtime",
      "device",
      "userdata/agent-pids",
      "userdata/agent-hook",
      "userdata/opencode-servers",
    ];
    const copied = ["future-state"];
    for (const entry of [...skipped, ...copied]) {
      NodeFS.mkdirSync(NodePath.join(source, entry), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(source, entry, "keep"), entry);
    }
    NodeFS.writeFileSync(NodePath.join(source, "userdata", "server-runtime.json"), '{"pid":123}');
    NodeFS.writeFileSync(NodePath.join(source, "userdata", "server-owner.sqlite"), "");
    const outcome = migrate();
    for (const entry of [
      ...skipped,
      "userdata/server-runtime.json",
      "userdata/server-owner.sqlite",
    ]) {
      expect(NodeFS.existsSync(NodePath.join(destination, entry)), entry).toBe(false);
    }
    for (const entry of copied)
      expect(NodeFS.readFileSync(NodePath.join(destination, entry, "keep"), "utf8")).toBe(entry);
    expect(
      outcome.kind === "migrated" && outcome.report.skipped.map((entry) => entry.path),
    ).toContain("worktrees");
  });

  it("restarts after an interruption and runs staged transformations before publishing", () => {
    seed();
    expect(() =>
      migrate([
        {
          name: "interrupted",
          run: (staged) => {
            NodeFS.writeFileSync(NodePath.join(staged, "partial"), "incomplete");
            throw new Error("injected failure");
          },
        },
      ]),
    ).toThrow("injected failure");
    expect(NodeFS.existsSync(destination)).toBe(false);
    expect(
      NodeFS.existsSync(NodePath.join(homeDirectory, ".paperplane-migration-stage", "partial")),
    ).toBe(true);
    migrate([
      {
        name: "rewrite-staged-data",
        run: (staged) => {
          const db = new NodeSqlite.DatabaseSync(
            NodePath.join(staged, "userdata", "statev2.sqlite"),
          );
          db.exec("UPDATE messages SET text = 'rewritten';");
          db.close();
        },
      },
    ]);
    expect(rows()).toEqual(["rewritten"]);
    expect(rows(NodePath.join(source, "userdata", "statev2.sqlite"))).toEqual(["hello"]);
    expect(NodeFS.existsSync(NodePath.join(destination, "partial"))).toBe(false);
  });

  it("refuses a held old server lock without publishing an empty home", () => {
    seed();
    const db = new NodeSqlite.DatabaseSync(
      NodePath.join(source, "userdata", "server-owner.sqlite"),
    );
    db.exec("BEGIN EXCLUSIVE;");
    try {
      expect(() => migrate()).toThrow(
        /Quit Rove Code.*systemctl --user disable --now rove.service/,
      );
      expect(NodeFS.existsSync(destination)).toBe(false);
    } finally {
      db.close();
    }
    expect(migrate().kind).toBe("migrated");
  });

  it("holds the source lock throughout copying and transformation", () => {
    seed();
    const lockPath = NodePath.join(source, "userdata", "server-owner.sqlite");
    NodeFS.writeFileSync(lockPath, "");
    migrate([
      {
        name: "old-server-restart",
        run: () => {
          const old = new NodeSqlite.DatabaseSync(lockPath);
          try {
            expect(() => old.exec("BEGIN EXCLUSIVE")).toThrow("database is locked");
          } finally {
            old.close();
          }
        },
      },
    ]);
  });

  it("does not let another migration delete an active staging directory", () => {
    seed();
    migrate([
      {
        name: "concurrent-start",
        run: (staged) => {
          expect(() => migrate()).toThrow("Another Paperplane home migration is running");
          expect(NodeFS.existsSync(NodePath.join(staged, "userdata", "settings.json"))).toBe(true);
        },
      },
    ]);
    expect(rows()).toEqual(["hello"]);
  });

  it("migrates into an empty destination that appears while transformations run", () => {
    seed();
    expect(
      migrate([{ name: "destination-created", run: () => NodeFS.mkdirSync(destination) }]),
    ).toMatchObject({ kind: "migrated" });
    expect(rows()).toEqual(["hello"]);
  });

  it("records a skip when userdata appears while transformations run", () => {
    seed();
    expect(
      migrate([
        {
          name: "new-install",
          run: () => NodeFS.mkdirSync(NodePath.join(destination, "userdata"), { recursive: true }),
        },
      ]),
    ).toMatchObject({ kind: "skipped", reason: "destination-userdata-exists" });
    expect(NodeFS.readdirSync(NodePath.join(destination, "userdata"))).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(destination, HOME_MIGRATION_REPORT))).toBe(true);
  });

  it("leaves every source byte and permission unchanged", () => {
    seed();
    NodeFS.writeFileSync(NodePath.join(source, "userdata", "server-owner.sqlite"), "");
    const before = snapshot(source);
    migrate();
    expect(snapshot(source)).toEqual(before);
  });

  // oxlint-disable-next-line paperplane/no-global-process-runtime -- Native file permission semantics depend on the host OS.
  it.skipIf(NodeOS.platform() === "win32").each([false, true])(
    "migrates a read-only source home root (destination exists: %s)",
    (destinationExists) => {
      seed();
      if (destinationExists) NodeFS.mkdirSync(destination, { mode: 0o700 });
      NodeFS.chmodSync(source, 0o500);
      try {
        expect(migrate().kind).toBe("migrated");
        expect(rows()).toEqual(["hello"]);
        expect(NodeFS.statSync(destination).mode & 0o777).toBe(destinationExists ? 0o700 : 0o500);
      } finally {
        NodeFS.chmodSync(source, 0o700);
        if (NodeFS.existsSync(destination)) NodeFS.chmodSync(destination, 0o700);
      }
    },
  );

  // oxlint-disable-next-line paperplane/no-global-process-runtime -- Native file permission semantics depend on the host OS.
  it.skipIf(NodeOS.platform() === "win32")(
    "preserves credential file and directory permissions",
    () => {
      seed();
      NodeFS.chmodSync(source, 0o700);
      NodeFS.chmodSync(NodePath.join(source, "userdata", "statev2.sqlite"), 0o600);
      migrate();
      for (const entry of ["", "userdata/secrets"])
        expect(NodeFS.statSync(NodePath.join(destination, entry)).mode & 0o777).toBe(0o700);
      for (const entry of [
        "userdata/secrets/token",
        "userdata/statev2.sqlite",
        HOME_MIGRATION_REPORT,
      ])
        expect(NodeFS.statSync(NodePath.join(destination, entry)).mode & 0o777).toBe(0o600);
    },
  );
});
