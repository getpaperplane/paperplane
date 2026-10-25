// @effect-diagnostics nodeBuiltinImport:off - All migration fixtures are private temp directories and fake ciphers; never Electron or a real secret store.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  DesktopMigrationError,
  removeOldDesktopCliShims,
  migrationAttempt,
  decryptLinuxString,
  finishDesktopMigration,
  prepareProfileMigration,
  type SecretMigrationAdapters,
} from "./DesktopMigration.ts";

let root: string;
beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "paperplane-desktop-migration-"));
});
afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});
const write = (path: string, contents: string) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, contents);
};
const json = (path: string) => JSON.parse(NodeFS.readFileSync(path, "utf8"));

function linuxBlob(plain: string, prefix = "v11", secret = "old-keyring-secret") {
  const key = NodeCrypto.pbkdf2Sync(
    prefix === "v10" ? "peanuts" : secret,
    "saltysalt",
    1,
    16,
    "sha1",
  );
  const cipher = NodeCrypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from(prefix), cipher.update(plain), cipher.final()]).toString(
    "base64",
  );
}

function setupSecrets(platform: NodeJS.Platform = "linux") {
  const stateDir = NodePath.join(root, "state");
  const userDataPath = NodePath.join(root, "paperplane");
  const pending = NodePath.join(stateDir, "desktop-name-migration", "input");
  NodeFS.mkdirSync(pending, { recursive: true });
  NodeFS.mkdirSync(userDataPath);
  const notices: string[] = [];
  const readLinuxSecret = vi.fn(() => Effect.succeed("old-keyring-secret"));
  const adapters: SecretMigrationAdapters = {
    readLinuxSecret: Effect.suspend(readLinuxSecret),
    encryptionAvailable: Effect.succeed(true),
    encrypt: (plain) => Effect.succeed(Buffer.from(`new-identity:${plain}`)),
    decrypt: (bytes) =>
      migrationAttempt(() => {
        const value = Buffer.from(bytes).toString();
        if (!value.startsWith("new-identity:")) throw new Error("Not the new identity");
        return value.slice("new-identity:".length);
      }),
    showNotice: (message) =>
      Effect.sync(() => {
        notices.push(message);
      }),
  };
  return {
    stateDir,
    userDataPath,
    pending,
    notices,
    readLinuxSecret,
    adapters,
    input: { stateDir, userDataPath, platform },
  };
}

const seedSecrets = (pending: string, token = linuxBlob("bearer-token")) => {
  write(
    NodePath.join(pending, "connection-catalog.json"),
    JSON.stringify({
      version: 1,
      encryptedCatalog: linuxBlob('{"credentials":["catalog-token"]}'),
    }),
  );
  write(
    NodePath.join(pending, "saved-environments.json"),
    JSON.stringify({
      version: 1,
      records: [{ environmentId: "host", encryptedBearerToken: token }],
    }),
  );
};

describe("old desktop command cleanup", () => {
  it.each(["linux", "darwin", "win32"] as const)(
    "removes only exact-marker shims on %s",
    (platform) => {
      const baseDir = NodePath.join(root, ".paperplane");
      const oldBin = NodePath.join(root, ".rove-code/bin");
      const owned = NodePath.join(oldBin, platform === "win32" ? "rove.cmd" : "rove");
      const marker = "Written by Rove Code: runs the desktop app's bundled rove CLI.";
      write(
        owned,
        platform === "win32" ? `@echo off\r\nrem ${marker}\r\n` : `#!/bin/sh\n# ${marker}\n`,
      );
      const foreign = NodePath.join(baseDir, "bin/rove");
      write(foreign, `echo '${marker}'\n`);
      const links = NodePath.join(root, "path");
      NodeFS.mkdirSync(links);
      if (platform !== "win32") NodeFS.symlinkSync(owned, NodePath.join(links, "rove"));
      removeOldDesktopCliShims({
        homeDirectory: root,
        baseDir,
        platform,
        linkDirectories: [links],
      });
      assert.isFalse(NodeFS.existsSync(owned));
      assert.equal(NodeFS.readFileSync(foreign, "utf8"), `echo '${marker}'\n`);
      assert.isFalse(NodeFS.existsSync(NodePath.join(links, "rove")));
      removeOldDesktopCliShims({
        homeDirectory: root,
        baseDir,
        platform,
        linkDirectories: [links],
      });
    },
  );
  it("leaves a foreign rove link and its target untouched", () => {
    const target = NodePath.join(root, "foreign");
    write(target, "#!/bin/sh\necho user-command\n");
    const link = NodePath.join(root, "rove");
    NodeFS.symlinkSync(target, link);
    removeOldDesktopCliShims({
      homeDirectory: root,
      baseDir: NodePath.join(root, ".paperplane"),
      platform: "linux",
      linkDirectories: [root],
    });
    assert.equal(NodeFS.readlinkSync(link), target);
  });
});

describe("independent desktop profile", () => {
  it.each(["linux", "darwin", "win32"] as const)(
    "copies once on %s and never shares files with the old app",
    (platform) => {
      const source = NodePath.join(root, "rove-v2");
      write(
        NodePath.join(source, "Local Storage", "leveldb", "000001.log"),
        "old preferences and drafts",
      );
      write(NodePath.join(source, "Partitions", "rove-preview-test", "Cookies"), "preview logins");
      write(
        NodePath.join(source, "Local State"),
        JSON.stringify({
          os_crypt: { encrypted_key: Buffer.from("DPAPIwrapped-key").toString("base64") },
        }),
      );
      write(NodePath.join(source, "Cache", "junk"), "rebuildable");
      const destination = prepareProfileMigration({
        appDataDirectory: root,
        isDevelopment: false,
        platform,
      });
      assert.equal(destination, NodePath.join(root, "paperplane"));
      const preferences = NodePath.join(destination, "Local Storage", "leveldb", "000001.log");
      assert.equal(NodeFS.readFileSync(preferences, "utf8"), "old preferences and drafts");
      assert.isFalse(NodeFS.existsSync(NodePath.join(destination, "Cache")));
      assert.equal(
        NodeFS.existsSync(
          NodePath.join(destination, "Partitions", "paperplane-preview-test", "Cookies"),
        ),
        platform === "win32",
      );
      assert.equal(
        NodeFS.existsSync(NodePath.join(destination, "Local State")),
        platform === "win32",
      );
      write(preferences, "new preferences");
      write(
        NodePath.join(source, platform === "win32" ? "lockfile" : "SingletonLock"),
        "old app restarted later",
      );
      assert.equal(
        prepareProfileMigration({ appDataDirectory: root, isDevelopment: false, platform }),
        destination,
      );
      assert.equal(NodeFS.readFileSync(preferences, "utf8"), "new preferences");
      assert.equal(
        NodeFS.readFileSync(
          NodePath.join(source, "Local Storage", "leveldb", "000001.log"),
          "utf8",
        ),
        "old preferences and drafts",
      );
    },
  );

  it.each(["linux", "darwin", "win32"] as const)(
    "defers while the old %s profile has a lock",
    (platform) => {
      const source = NodePath.join(root, "rove-v2");
      write(NodePath.join(source, "Local State"), "unchanged");
      const lock = NodePath.join(source, platform === "win32" ? "lockfile" : "SingletonLock");
      if (platform === "win32") write(lock, "held");
      else NodeFS.symlinkSync("old-host-4242", lock); // Dangling symlinks are still locks.
      assert.throws(
        () => prepareProfileMigration({ appDataDirectory: root, isDevelopment: false, platform }),
        /Quit Rove Code/,
      );
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, "paperplane")));
      assert.equal(NodeFS.readFileSync(NodePath.join(source, "Local State"), "utf8"), "unchanged");
      NodeFS.unlinkSync(lock);
      assert.equal(
        prepareProfileMigration({ appDataDirectory: root, isDevelopment: false, platform }),
        NodePath.join(root, "paperplane"),
      );
    },
  );

  it("renames default and profile partitions only in the staged copy, preserving conflicts", () => {
    const source = NodePath.join(root, "rove-v2");
    const names = ["f051bb2c68cb7b2fe969", "profile-78f0be89237d77f7a70e"];
    for (const name of names) {
      write(
        NodePath.join(source, "Partitions", `rove-preview-${name}`, "Local Storage", "data"),
        name,
      );
    }
    write(NodePath.join(source, "Partitions", "unrelated", "data"), "leave alone");
    write(NodePath.join(source, "Partitions", "rove-preview-conflict", "data"), "old");
    write(NodePath.join(source, "Partitions", "paperplane-preview-conflict", "data"), "new");
    write(NodePath.join(source, "Partitions", "rove-preview-empty", "data"), "old empty conflict");
    NodeFS.mkdirSync(NodePath.join(source, "Partitions", "paperplane-preview-empty"));

    const destination = prepareProfileMigration({
      appDataDirectory: root,
      isDevelopment: false,
      platform: "linux",
    });
    for (const name of names) {
      assert.equal(
        NodeFS.readFileSync(
          NodePath.join(
            destination,
            "Partitions",
            `paperplane-preview-${name}`,
            "Local Storage",
            "data",
          ),
          "utf8",
        ),
        name,
      );
      assert.isFalse(
        NodeFS.existsSync(NodePath.join(destination, "Partitions", `rove-preview-${name}`)),
      );
      assert.equal(
        NodeFS.readFileSync(
          NodePath.join(source, "Partitions", `rove-preview-${name}`, "Local Storage", "data"),
          "utf8",
        ),
        name,
      );
    }
    const partitions = NodePath.join(destination, "Partitions");
    assert.equal(
      NodeFS.readFileSync(NodePath.join(partitions, "unrelated", "data"), "utf8"),
      "leave alone",
    );
    assert.equal(
      NodeFS.readFileSync(NodePath.join(partitions, "rove-preview-conflict", "data"), "utf8"),
      "old",
    );
    assert.equal(
      NodeFS.readFileSync(NodePath.join(partitions, "paperplane-preview-conflict", "data"), "utf8"),
      "new",
    );
    assert.deepEqual(NodeFS.readdirSync(NodePath.join(partitions, "paperplane-preview-empty")), []);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(partitions, "rove-preview-empty", "data"), "utf8"),
      "old empty conflict",
    );
  });

  it("discards an interrupted stage and refuses a source that starts during copying", () => {
    write(NodePath.join(root, "rove-v2", "preferences"), "good");
    write(NodePath.join(root, "paperplane-migration-stage", "preferences"), "incomplete");
    let probes = 0;
    assert.throws(
      () =>
        prepareProfileMigration(
          { appDataDirectory: root, isDevelopment: false, platform: "linux" },
          () => ++probes === 2,
        ),
      /Quit Rove Code/,
    );
    assert.isFalse(NodeFS.existsSync(NodePath.join(root, "paperplane")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(root, "paperplane-migration-stage")));
    prepareProfileMigration({ appDataDirectory: root, isDevelopment: false, platform: "linux" });
    assert.equal(
      NodeFS.readFileSync(NodePath.join(root, "paperplane", "preferences"), "utf8"),
      "good",
    );
  });

  it("keeps development separate and never revives the retired V1 profile", () => {
    write(NodePath.join(root, "rove-code-dev", "preferences"), "retired");
    write(NodePath.join(root, "rove-v2", "preferences"), "production");
    const input = { appDataDirectory: root, isDevelopment: true, platform: "linux" as const };
    assert.equal(prepareProfileMigration(input), NodePath.join(root, "paperplane-dev"));
    assert.isFalse(NodeFS.existsSync(NodePath.join(root, "paperplane-dev")));
    write(NodePath.join(root, "rove-dev", "preferences"), "development");
    prepareProfileMigration(input);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(root, "paperplane-dev", "preferences"), "utf8"),
      "development",
    );
  });
});

describe("one-time saved sign-ins", () => {
  it.effect(
    "carries the Windows DPAPI key and validates both old stores under the new app name",
    () => {
      const fixture = setupSecrets("win32");
      NodeFS.rmdirSync(fixture.userDataPath);
      const key = Buffer.from("DPAPIwrapped-user-key").toString("base64");
      const oldState = JSON.stringify({
        os_crypt: { encrypted_key: key },
        profile: { last_used: "Default" },
      });
      write(NodePath.join(root, "rove-v2", "Local State"), oldState);
      write(
        NodePath.join(root, "rove-v2", "Partitions", "rove-preview-test", "Cookies"),
        "encrypted-cookie-db",
      );
      prepareProfileMigration({ appDataDirectory: root, isDevelopment: false, platform: "win32" });
      // Fake DPAPI binds to this user/key, not either app name. No OS APIs run.
      const protect = (value: string) => Buffer.from(`${key}:${value}`).toString("base64");
      write(
        NodePath.join(fixture.pending, "connection-catalog.json"),
        JSON.stringify({ version: 1, encryptedCatalog: protect("catalog-token") }),
      );
      write(
        NodePath.join(fixture.pending, "saved-environments.json"),
        JSON.stringify({ records: [{ encryptedBearerToken: protect("bearer-token") }] }),
      );
      const adapters = {
        ...fixture.adapters,
        readLinuxSecret: Effect.die("no keyring on Windows"),
        encrypt: () => Effect.die("do not replace a carried DPAPI key"),
        decrypt: (bytes: Uint8Array) =>
          migrationAttempt(() => {
            const carried = json(NodePath.join(fixture.userDataPath, "Local State")).os_crypt
              .encrypted_key;
            const value = Buffer.from(bytes).toString();
            if (!value.startsWith(`${carried}:`)) throw new Error("Wrong Windows user key");
            return value.slice(carried.length + 1);
          }),
      };
      return Effect.gen(function* () {
        yield* finishDesktopMigration(fixture.input, adapters);
        assert.equal(
          NodeFS.readFileSync(NodePath.join(fixture.userDataPath, "Local State"), "utf8"),
          oldState,
        );
        assert.equal(
          NodeFS.readFileSync(NodePath.join(root, "rove-v2", "Local State"), "utf8"),
          oldState,
        );
        assert.equal(
          yield* adapters.decrypt(
            Buffer.from(
              json(NodePath.join(fixture.stateDir, "connection-catalog.json")).encryptedCatalog,
              "base64",
            ),
          ),
          "catalog-token",
        );
        assert.equal(
          yield* adapters.decrypt(
            Buffer.from(
              json(NodePath.join(fixture.stateDir, "saved-environments.json")).records[0]
                .encryptedBearerToken,
              "base64",
            ),
          ),
          "bearer-token",
        );
        assert.equal(
          NodeFS.readFileSync(
            NodePath.join(fixture.userDataPath, "Partitions", "paperplane-preview-test", "Cookies"),
            "utf8",
          ),
          "encrypted-cookie-db",
        );
        assert.deepEqual(fixture.notices, []);
        write(NodePath.join(fixture.userDataPath, "Local State"), "newer Windows key");
        prepareProfileMigration({
          appDataDirectory: root,
          isDevelopment: false,
          platform: "win32",
        });
        yield* finishDesktopMigration(fixture.input, adapters);
        assert.equal(
          NodeFS.readFileSync(NodePath.join(fixture.userDataPath, "Local State"), "utf8"),
          "newer Windows key",
        );
      });
    },
  );

  it.effect(
    "drops Windows preview cookies and explains sign-in when no transferable DPAPI key exists",
    () => {
      const fixture = setupSecrets("win32");
      NodeFS.rmdirSync(fixture.userDataPath);
      write(
        NodePath.join(root, "rove-v2", "Local State"),
        '{"os_crypt":{"encrypted_key":"invalid"}}',
      );
      write(NodePath.join(root, "rove-v2", "Cookies"), "cannot-decrypt");
      prepareProfileMigration({ appDataDirectory: root, isDevelopment: false, platform: "win32" });
      return Effect.gen(function* () {
        yield* finishDesktopMigration(fixture.input, fixture.adapters);
        assert.isFalse(NodeFS.existsSync(NodePath.join(fixture.userDataPath, "Cookies")));
        assert.include(fixture.notices[0]!, "Sign in again in the preview panel");
      });
    },
  );

  it.effect(
    "converts every Linux libsecret credential through the new identity, leaving old ciphertext untouched",
    () => {
      const fixture = setupSecrets();
      seedSecrets(fixture.pending);
      const oldCatalog = NodeFS.readFileSync(
        NodePath.join(fixture.pending, "connection-catalog.json"),
        "utf8",
      );
      return Effect.gen(function* () {
        yield* finishDesktopMigration(fixture.input, fixture.adapters);
        const catalog = json(NodePath.join(fixture.stateDir, "connection-catalog.json"));
        assert.equal(
          yield* fixture.adapters.decrypt(Buffer.from(catalog.encryptedCatalog, "base64")),
          '{"credentials":["catalog-token"]}',
        );
        const registry = json(NodePath.join(fixture.stateDir, "saved-environments.json"));
        assert.equal(
          yield* fixture.adapters.decrypt(
            Buffer.from(registry.records[0].encryptedBearerToken, "base64"),
          ),
          "bearer-token",
        );
        assert.equal(
          NodeFS.readFileSync(NodePath.join(fixture.pending, "connection-catalog.json"), "utf8"),
          oldCatalog,
        );
        assert.equal(fixture.readLinuxSecret.mock.calls.length, 1);
        assert.deepEqual(fixture.notices, []);
        yield* finishDesktopMigration(fixture.input, {
          ...fixture.adapters,
          encrypt: () => Effect.die("must not convert twice"),
        });
        assert.equal(fixture.readLinuxSecret.mock.calls.length, 1);
      });
    },
  );

  it.effect("converts the basic fixed-key fallback without contacting a keyring", () => {
    const fixture = setupSecrets();
    write(
      NodePath.join(fixture.pending, "connection-catalog.json"),
      JSON.stringify({ version: 1, encryptedCatalog: linuxBlob("basic-token", "v10") }),
    );
    return Effect.gen(function* () {
      yield* finishDesktopMigration(fixture.input, {
        ...fixture.adapters,
        readLinuxSecret: Effect.die("no keyring"),
      });
      assert.equal(
        yield* fixture.adapters.decrypt(
          Buffer.from(
            json(NodePath.join(fixture.stateDir, "connection-catalog.json")).encryptedCatalog,
            "base64",
          ),
        ),
        "basic-token",
      );
      assert.deepEqual(fixture.notices, []);
    });
  });

  it.effect.each(["locked", "kwallet", "corrupt", "new-key-unavailable", "macOS"])(
    "leaves no partial store and explains %s loss only once",
    (reason) => {
      const fixture = setupSecrets(reason === "macOS" ? "darwin" : "linux");
      seedSecrets(fixture.pending, reason === "corrupt" ? "broken" : linuxBlob("token"));
      write(
        NodePath.join(fixture.userDataPath, "paperplane-profile-migration.json"),
        JSON.stringify({ version: 1, previewSignIn: true, noticeShown: false }),
      );
      const adapters = {
        ...fixture.adapters,
        ...(reason === "locked" || reason === "kwallet"
          ? { readLinuxSecret: Effect.fail(new DesktopMigrationError({ cause: reason })) }
          : {}),
        ...(reason === "new-key-unavailable" ? { encryptionAvailable: Effect.succeed(false) } : {}),
        ...(reason === "macOS"
          ? {
              readLinuxSecret: Effect.die("no macOS keychain code"),
              encryptionAvailable: Effect.die("must not touch macOS keys"),
            }
          : {}),
      };
      return Effect.gen(function* () {
        yield* finishDesktopMigration(fixture.input, adapters);
        assert.isFalse(
          NodeFS.existsSync(NodePath.join(fixture.stateDir, "connection-catalog.json")),
        );
        assert.isFalse(
          NodeFS.existsSync(NodePath.join(fixture.stateDir, "saved-environments.json")),
        );
        assert.equal(fixture.notices.length, 1);
        assert.include(fixture.notices[0]!, "Pair your remote hosts again");
        assert.include(fixture.notices[0]!, "Sign in again in the preview panel");
        yield* finishDesktopMigration(fixture.input, adapters);
        assert.equal(fixture.notices.length, 1);
      });
    },
  );

  it.effect.each(["connection-catalog.json", "saved-environments.json"])(
    "does not overwrite new %s or merge stale credentials behind it",
    (name) => {
      const fixture = setupSecrets();
      seedSecrets(fixture.pending);
      write(NodePath.join(fixture.stateDir, name), "new user data");
      return Effect.gen(function* () {
        yield* finishDesktopMigration(fixture.input, fixture.adapters);
        assert.equal(
          NodeFS.readFileSync(NodePath.join(fixture.stateDir, name), "utf8"),
          "new user data",
        );
        const other =
          name === "connection-catalog.json"
            ? "saved-environments.json"
            : "connection-catalog.json";
        assert.isFalse(NodeFS.existsSync(NodePath.join(fixture.stateDir, other)));
        assert.equal(fixture.readLinuxSecret.mock.calls.length, 0);
      });
    },
  );

  it.effect(
    "notifies about the omitted pre-ready Clerk store without exposing it to the SDK",
    () => {
      const fixture = setupSecrets();
      write(NodePath.join(fixture.pending, "clerk-tokens.json"), '{"token":"enc:old"}');
      return Effect.gen(function* () {
        yield* finishDesktopMigration(fixture.input, fixture.adapters);
        assert.isFalse(NodeFS.existsSync(NodePath.join(fixture.stateDir, "clerk-tokens.json")));
        assert.include(fixture.notices[0]!, "Sign in to Paperplane Connect again");
        yield* finishDesktopMigration(fixture.input, fixture.adapters);
        assert.equal(fixture.notices.length, 1);
      });
    },
  );

  it.effect(
    "resumes publication after interruption without overwriting already-published values",
    () => {
      const fixture = setupSecrets();
      seedSecrets(fixture.pending);
      const prepared = NodePath.join(fixture.stateDir, "desktop-name-migration", "prepared");
      write(NodePath.join(prepared, "connection-catalog.json"), "prepared catalog");
      write(NodePath.join(prepared, "saved-environments.json"), "prepared registry");
      write(
        NodePath.join(prepared, "ready.json"),
        JSON.stringify({
          version: 1,
          remoteHosts: false,
          connectSignIn: false,
          noticeShown: false,
        }),
      );
      write(
        NodePath.join(fixture.stateDir, "connection-catalog.json"),
        "already published and edited",
      );
      return Effect.gen(function* () {
        yield* finishDesktopMigration(fixture.input, {
          ...fixture.adapters,
          encrypt: () => Effect.die("must not reconvert"),
        });
        assert.equal(
          NodeFS.readFileSync(NodePath.join(fixture.stateDir, "connection-catalog.json"), "utf8"),
          "already published and edited",
        );
        assert.equal(
          NodeFS.readFileSync(NodePath.join(fixture.stateDir, "saved-environments.json"), "utf8"),
          "prepared registry",
        );
      });
    },
  );

  it("rejects unsupported and undecryptable Linux blobs", () => {
    assert.throws(() => decryptLinuxString(Buffer.from("v20unsupported")), /Unsupported/);
    assert.throws(
      () => decryptLinuxString(Buffer.from(linuxBlob("text"), "base64")),
      /without unlocking/,
    );
    assert.throws(() => decryptLinuxString(Buffer.from(linuxBlob("text"), "base64"), "wrong-key"));
  });
});
