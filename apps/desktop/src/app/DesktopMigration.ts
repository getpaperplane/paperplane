// @effect-diagnostics nodeBuiltinImport:off - Deletable, synchronous first-start migration must run before Electron's ready event.
/** One-time Rove Code → Paperplane desktop conversion. Delete as a unit after the migration window. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { fromLenientJson } from "@getpaperplane/shared/schemaJson";
import { publishHomeMigration } from "@getpaperplane/shared/homeMigration";
import { readLinuxSecret } from "../preview/BrowserImport/ChromiumKeys.ts";
import * as LinuxBrowserSecret from "../preview/BrowserImport/LinuxBrowserSecret.ts";

const OLD_CLI_MARKER = "Written by Rove Code: runs the desktop app's bundled rove CLI.";

/** Exact historical comment line, not merely a mention in a user's script. */
export function isOldDesktopCliShim(contents: string) {
  return contents
    .split(/\r?\n/)
    .some((line) => line === `# ${OLD_CLI_MARKER}` || line === `rem ${OLD_CLI_MARKER}`);
}

/** The migrated private record proves which default-home directory the desktop added. */
export function oldOwnedCliPath(
  home: string,
  record: string | undefined,
  join: (...paths: string[]) => string,
) {
  const oldBin = join(home, ".rove-code", "bin");
  const normalize = (value: string) => value.replace(/[\\/]+$/, "").toLowerCase();
  return record !== undefined && normalize(record.trim()) === normalize(oldBin)
    ? oldBin
    : undefined;
}

/** Remove only marker-owned launchers and symlinks, after the new command is written. */
export function removeOldDesktopCliShims(input: {
  readonly homeDirectory: string;
  readonly baseDir: string;
  readonly platform: NodeJS.Platform;
  readonly linkDirectories?: readonly string[];
}) {
  const owned = (filename: string) => {
    try {
      const info = NodeFS.statSync(filename);
      return (
        info.isFile() &&
        info.size <= 16_384 &&
        isOldDesktopCliShim(NodeFS.readFileSync(filename, "utf8"))
      );
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    }
  };
  const directories = input.linkDirectories ?? [
    ...(input.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : []),
    NodePath.join(input.homeDirectory, ".local/bin"),
    NodePath.join(input.homeDirectory, "bin"),
  ];
  if (input.platform !== "win32") {
    for (const directory of directories) {
      const filename = NodePath.join(directory, "rove");
      if (exists(filename) && NodeFS.lstatSync(filename).isSymbolicLink() && owned(filename))
        NodeFS.unlinkSync(filename);
    }
  }
  for (const base of new Set([input.baseDir, NodePath.join(input.homeDirectory, ".rove-code")])) {
    for (const name of ["rove", "rove.cmd"]) {
      const filename = NodePath.join(base, "bin", name);
      if (owned(filename) && NodeFS.lstatSync(filename).isFile()) NodeFS.unlinkSync(filename);
    }
  }
}

export class DesktopMigrationError extends Schema.TaggedError<DesktopMigrationError>()(
  "DesktopMigrationError",
  { cause: Schema.Defect() },
) {}
export const migrationEffect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => new DesktopMigrationError({ cause })));
export const migrationAttempt = <A>(run: () => A) =>
  Effect.try({ try: run, catch: (cause) => new DesktopMigrationError({ cause }) });
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const PROFILE_REPORT = "paperplane-profile-migration.json";
const decodeProfileReport = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      previewSignIn: Schema.Boolean,
      noticeShown: Schema.Boolean,
    }),
  ),
);
const decodeSecretReport = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      remoteHosts: Schema.Boolean,
      connectSignIn: Schema.Boolean,
      noticeShown: Schema.Boolean,
    }),
  ),
);
const decodeDocument = Schema.decodeUnknownSync(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);

function exists(path: string) {
  try {
    NodeFS.lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export interface ProfileMigrationInput {
  readonly appDataDirectory: string;
  readonly isDevelopment: boolean;
  readonly platform: NodeJS.Platform;
}

/** Conservatively retain crash locks too: reopening and quitting the old app clears them. No process is signalled. */
export function oldProfileIsInUse(source: string, platform: NodeJS.Platform) {
  return exists(NodePath.join(source, platform === "win32" ? "lockfile" : "SingletonLock"));
}

function hasWindowsKey(source: string) {
  const state = NodePath.join(source, "Local State");
  if (!exists(state)) return false;
  const contents = NodeFS.readFileSync(state, "utf8");
  try {
    const crypt = decodeDocument(contents).os_crypt;
    if (
      typeof crypt !== "object" ||
      crypt === null ||
      !("encrypted_key" in crypt) ||
      typeof crypt.encrypted_key !== "string"
    )
      return false;
    const wrapped = secretBytes(crypt.encrypted_key);
    return wrapped.length > 5 && wrapped.subarray(0, 5).toString() === "DPAPI";
  } catch {
    return false;
  }
}

/** Copies only regular files/directories, never links back into a running old profile. */
function copyProfile(source: string, destination: string, keepEncrypted: boolean): void {
  NodeFS.mkdirSync(destination, { mode: 0o700 });
  for (const entry of NodeFS.readdirSync(source, { withFileTypes: true })) {
    if (
      entry.name.startsWith("Singleton") ||
      entry.name === "lockfile" ||
      ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache"].includes(
        entry.name,
      ) ||
      (!keepEncrypted && /^(?:Cookies(?:-(?:wal|shm|journal))?|Local State)$/.test(entry.name))
    )
      continue;
    const from = NodePath.join(source, entry.name);
    const to = NodePath.join(destination, entry.name);
    if (entry.isDirectory()) copyProfile(from, to, keepEncrypted);
    else if (entry.isFile()) NodeFS.copyFileSync(from, to, NodeFS.constants.COPYFILE_EXCL);
  }
}

/** Runs before Clerk or Chromium opens the new profile. A crash retries the private stage, never a published profile. */
export function prepareProfileMigration(input: ProfileMigrationInput, isInUse = oldProfileIsInUse) {
  const destination = NodePath.join(
    input.appDataDirectory,
    input.isDevelopment ? "paperplane-dev" : "paperplane",
  );
  const source = NodePath.join(
    input.appDataDirectory,
    input.isDevelopment ? "rove-dev" : "rove-v2",
  );
  if (exists(destination) || !exists(source)) return destination;
  NodeFS.mkdirSync(input.appDataDirectory, { recursive: true });
  const guard = new NodeSqlite.DatabaseSync(`${destination}-migration.sqlite`);
  try {
    try {
      guard.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    } catch {
      throw new Error(
        "Another Paperplane is copying your desktop data. Close it, then start Paperplane again.",
      );
    }
    if (exists(destination)) return destination;
    const assertStopped = () => {
      if (isInUse(source, input.platform))
        throw new Error(
          "Quit Rove Code, then start Paperplane again. Its desktop profile is still in use; nothing has been copied. " +
            "If Rove Code previously crashed, open it and quit it once to release its profile lock.",
        );
    };
    assertStopped();
    const stage = `${destination}-migration-stage`;
    NodeFS.rmSync(stage, { recursive: true, force: true });
    try {
      const keepEncrypted = input.platform === "win32" && hasWindowsKey(source);
      copyProfile(source, stage, keepEncrypted);
      assertStopped();
      NodeFS.writeFileSync(
        NodePath.join(stage, PROFILE_REPORT),
        JSON.stringify({
          version: 1,
          previewSignIn: !keepEncrypted,
          noticeShown: false,
        }),
        { mode: 0o600, flag: "wx" },
      );
      publishHomeMigration(stage, destination);
    } finally {
      NodeFS.rmSync(stage, { recursive: true, force: true });
    }
    return destination;
  } finally {
    guard.close();
  }
}

function writeJson(path: string, value: unknown) {
  const next = `${path}.next`;
  NodeFS.writeFileSync(next, JSON.stringify(value) + "\n", { mode: 0o600 });
  NodeFS.renameSync(next, path);
}

function secretBytes(encoded: string) {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Error("Invalid encrypted credential.");
  return bytes;
}

/** OSCrypt sync strings have no cookie host digest: v10/v11 + AES-128-CBC, IV of sixteen spaces. */
export function decryptLinuxString(bytes: Buffer, keyringSecret?: string) {
  const prefix = bytes.toString("ascii", 0, 3);
  if (prefix !== "v10" && prefix !== "v11") throw new Error("Unsupported encrypted credential.");
  const passphrase = prefix === "v10" ? "peanuts" : keyringSecret;
  if (passphrase === undefined)
    throw new Error("The old keyring could not be read without unlocking it.");
  const key = NodeCrypto.pbkdf2Sync(passphrase, "saltysalt", 1, 16, "sha1");
  const decipher = NodeCrypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const plain = Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]);
  return new TextDecoder("utf-8", { fatal: true }).decode(plain);
}

/** Exact Electron OSCrypt application attribute; unlike browser-import, this must never unlock a collection. */
export const readOldLinuxSecret = (stageLabel: string) =>
  readLinuxSecret(`Rove Code ${stageLabel}`, { noUnlock: true }).pipe(
    Effect.provide(LinuxBrowserSecret.layer),
    migrationEffect,
  );

export interface SecretMigrationAdapters<R = never> {
  readonly readLinuxSecret: Effect.Effect<string, DesktopMigrationError, R>;
  readonly encryptionAvailable: Effect.Effect<boolean, DesktopMigrationError, R>;
  readonly encrypt: (plain: string) => Effect.Effect<Uint8Array, DesktopMigrationError, R>;
  readonly decrypt: (bytes: Uint8Array) => Effect.Effect<string, DesktopMigrationError, R>;
  readonly showNotice: (message: string) => Effect.Effect<unknown, DesktopMigrationError, R>;
}

/** Completes before any window/catalog reader. Prepared ciphertext is the crash-recovery journal; plaintext never reaches disk. */
export const finishDesktopMigration = Effect.fn("desktop.migration.finish")(function* <R>(
  input: {
    readonly stateDir: string;
    readonly userDataPath: string;
    readonly platform: NodeJS.Platform;
  },
  adapters: SecretMigrationAdapters<R>,
) {
  const directory = NodePath.join(input.stateDir, "desktop-name-migration");
  const pending = NodePath.join(directory, "input");
  const prepared = NodePath.join(directory, "prepared");
  const resultPath = NodePath.join(directory, "result.json");
  const profilePath = NodePath.join(input.userDataPath, PROFILE_REPORT);
  const profile = yield* migrationAttempt(() =>
    exists(profilePath) ? decodeProfileReport(NodeFS.readFileSync(profilePath, "utf8")) : undefined,
  );
  if (yield* migrationAttempt(() => exists(pending) && !exists(resultPath))) {
    const catalog = "connection-catalog.json";
    const registry = "saved-environments.json";
    const clerk = "clerk-tokens.json";
    const readyPath = NodePath.join(prepared, "ready.json");
    if (!(yield* migrationAttempt(() => exists(readyPath)))) {
      yield* migrationAttempt(() => NodeFS.rmSync(prepared, { recursive: true, force: true }));
      const outcome = yield* Effect.gen(function* () {
        // Never merge old credentials into a catalog already created by Paperplane.
        if ([catalog, registry].some((name) => exists(NodePath.join(input.stateDir, name))))
          return { remoteHosts: false };
        const names = [catalog, registry].filter(
          (name) =>
            exists(NodePath.join(pending, name)) && !exists(NodePath.join(input.stateDir, name)),
        );
        if (names.length === 0) return { remoteHosts: false };
        if (input.platform === "darwin") return { remoteHosts: true };
        let keyringSecret: string | undefined;
        let keyringRead = false;
        let availabilityChecked = false;
        const convert = Effect.fnUntraced(function* (encoded: string) {
          const bytes = yield* migrationAttempt(() => secretBytes(encoded));
          if (!availabilityChecked) {
            if (!(yield* adapters.encryptionAvailable))
              return yield* new DesktopMigrationError({ cause: "Encryption unavailable." });
            availabilityChecked = true;
          }
          if (input.platform === "win32") {
            // Local State was copied before Electron initialized DPAPI. Validate every blob, retain its bytes.
            yield* adapters.decrypt(bytes);
            return encoded;
          }
          if (input.platform !== "linux")
            return yield* new DesktopMigrationError({ cause: "Unsupported platform." });
          if (bytes.toString("ascii", 0, 3) === "v11" && !keyringRead) {
            keyringSecret = yield* adapters.readLinuxSecret;
            keyringRead = true;
          }
          const plain = yield* migrationAttempt(() => decryptLinuxString(bytes, keyringSecret));
          const encrypted = yield* adapters.encrypt(plain);
          // Catch a bad new key/backend before publishing anything.
          if ((yield* adapters.decrypt(encrypted)) !== plain)
            return yield* new DesktopMigrationError({ cause: "Credential verification failed." });
          return Buffer.from(encrypted).toString("base64");
        });
        const output: Record<string, string> = {};
        for (const name of names) {
          const document = {
            ...(yield* migrationAttempt(() =>
              decodeDocument(NodeFS.readFileSync(NodePath.join(pending, name), "utf8")),
            )),
          };
          if (name === catalog) {
            if (document.version !== 1 || typeof document.encryptedCatalog !== "string")
              return yield* new DesktopMigrationError({ cause: "Invalid old catalog." });
            document.encryptedCatalog = yield* convert(document.encryptedCatalog);
          } else {
            if (!Array.isArray(document.records))
              return yield* new DesktopMigrationError({ cause: "Invalid old saved hosts." });
            for (const value of document.records) {
              if (typeof value !== "object" || value === null)
                return yield* new DesktopMigrationError({ cause: "Invalid old saved host." });
              if ("encryptedBearerToken" in value) {
                if (typeof value.encryptedBearerToken !== "string")
                  return yield* new DesktopMigrationError({ cause: "Invalid old token." });
                value.encryptedBearerToken = yield* convert(value.encryptedBearerToken);
              }
            }
          }
          output[name] = encodeJson(document) + "\n";
        }
        // All decryptions/encryptions succeeded. A previous unprepared stage is disposable.
        yield* migrationAttempt(() => {
          NodeFS.rmSync(prepared, { recursive: true, force: true });
          NodeFS.mkdirSync(prepared, { mode: 0o700 });
          for (const [name, contents] of Object.entries(output))
            NodeFS.writeFileSync(NodePath.join(prepared, name), contents, { mode: 0o600 });
        });
        return { remoteHosts: false };
      }).pipe(Effect.orElseSucceed(() => ({ remoteHosts: true })));
      yield* migrationAttempt(() => {
        NodeFS.mkdirSync(prepared, { recursive: true, mode: 0o700 });
        writeJson(readyPath, {
          version: 1,
          ...outcome,
          connectSignIn: exists(NodePath.join(pending, clerk)),
          noticeShown: false,
        });
      });
    }
    // I/O publication failures stop startup, not conversion: next start resumes from the prepared journal.
    yield* migrationAttempt(() => {
      const result = decodeSecretReport(NodeFS.readFileSync(readyPath, "utf8"));
      if (!result.remoteHosts) {
        for (const name of [catalog, registry]) {
          const source = NodePath.join(prepared, name);
          if (!exists(source)) continue;
          try {
            NodeFS.linkSync(source, NodePath.join(input.stateDir, name));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        }
      }
      writeJson(resultPath, result);
    });
  }
  const secrets = yield* migrationAttempt(() =>
    exists(resultPath) ? decodeSecretReport(NodeFS.readFileSync(resultPath, "utf8")) : undefined,
  );
  const messages = [
    secrets && !secrets.noticeShown && secrets.remoteHosts ? "Pair your remote hosts again." : "",
    profile && !profile.noticeShown && profile.previewSignIn
      ? "Sign in again in the preview panel."
      : "",
    secrets && !secrets.noticeShown && secrets.connectSignIn
      ? "Sign in to Paperplane Connect again if you use it."
      : "",
  ].filter(Boolean);
  if (messages.length > 0)
    yield* adapters.showNotice(
      "Paperplane could not bring over all of your saved sign-ins.\n\n" +
        messages.join("\n") +
        "\n\nYour Rove Code data is unchanged and is kept as a backup.",
    );
  yield* migrationAttempt(() => {
    if (profile && !profile.noticeShown) writeJson(profilePath, { ...profile, noticeShown: true });
    if (secrets && !secrets.noticeShown) writeJson(resultPath, { ...secrets, noticeShown: true });
  });
});
