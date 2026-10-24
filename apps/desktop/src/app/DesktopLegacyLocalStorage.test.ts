import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";
import { prepareProfileMigration } from "./DesktopMigration.ts";

// A small LevelDB FULL record with a CRC32C header, not a mocked decoder result.
function logRecord(payload: Buffer) {
  const checked = Buffer.concat([Buffer.from([1]), payload]);
  let crc = 0xffffffff;
  for (const byte of checked) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const header = Buffer.alloc(7);
  header.writeUInt32LE((((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0);
  header.writeUInt16LE(payload.length, 4);
  header[6] = 1;
  return Buffer.concat([header, payload]);
}

const writeProfile = Effect.fnUntraced(function* (
  root: string,
  name: string,
  development: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(root, name, "Local Storage", "leveldb");
  const origin = development ? "rove-dev://app" : "rove://app";
  const key = Buffer.from(`_${origin}\0\x01prompt-draft`);
  const value = Buffer.from(`\x01draft-from-${name}`);
  const batch = Buffer.alloc(12);
  batch.writeUInt32LE(1); // first sequence
  batch.writeUInt32LE(1, 8); // one put
  const log = logRecord(
    Buffer.concat([batch, Buffer.from([1, key.length]), key, Buffer.from([value.length]), value]),
  );
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(path.join(directory, "CURRENT"), "MANIFEST-000001\n");
  // VersionEdit: log 2, next file 3, last sequence 1; no sorted tables.
  yield* fs.writeFile(
    path.join(directory, "MANIFEST-000001"),
    logRecord(Buffer.from([2, 2, 3, 3, 4, 1])),
  );
  yield* fs.writeFile(path.join(directory, "000002.log"), log);
  yield* fs.writeFileString(path.join(directory, "LOCK"), "V1 owns this database");
  return { directory, log };
});

const makeImporter = (appDataDirectory: string, development: boolean) =>
  DesktopLegacyLocalStorage.DesktopLegacyLocalStorage.pipe(
    Effect.provide(
      DesktopLegacyLocalStorage.layer.pipe(
        Layer.provide(
          DesktopEnvironment.layer({
            dirname: "/repo/apps/desktop/dist-electron",
            homeDirectory: "/sandbox",
            platform: "linux",
            processArch: "x64",
            appVersion: "1.2.3",
            appPath: "/repo",
            isPackaged: !development,
            resourcesPath: "/repo/resources",
            runningUnderArm64Translation: false,
          }),
        ),
        Layer.provide(
          DesktopConfig.layerTest({
            XDG_CONFIG_HOME: appDataDirectory,
            VITE_DEV_SERVER_URL: development ? "http://localhost:5173" : undefined,
          }),
        ),
      ),
    ),
  );

it.effect.each([false, true])(
  "imports only the matching Paperplane V1 profile without modifying it (development: %s)",
  (development) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "paperplane-local-storage-" });
      const name = development ? "rove-code-dev" : "rove-code";
      const source = yield* writeProfile(root, name, development);
      // Valid competing databases must never supply this mode's drafts.
      yield* writeProfile(root, development ? "rove-code" : "rove-code-dev", !development);
      yield* writeProfile(root, "rove", development);
      yield* writeProfile(root, "Rove Code (Alpha)", development);
      const destination = path.join(root, development ? "paperplane-dev" : "paperplane");
      yield* fs.makeDirectory(destination);
      const marker = path.join(destination, "paperplane-local-storage-imported");
      const importer = yield* makeImporter(root, development);
      yield* importer.load(destination);
      assert.deepEqual(yield* importer.take, Option.some({ "prompt-draft": `draft-from-${name}` }));
      assert.deepEqual(yield* importer.take, Option.none());
      assert.isFalse(yield* fs.exists(marker));
      yield* importer.complete;
      assert.isTrue(yield* fs.exists(marker));
      assert.deepEqual(yield* fs.readFile(path.join(source.directory, "000002.log")), source.log);
      assert.equal(
        yield* fs.readFileString(path.join(source.directory, "LOCK")),
        "V1 owns this database",
      );
      assert.deepEqual((yield* fs.readDirectory(destination)).sort(), [
        "paperplane-local-storage-imported",
      ]);
      const nextLaunch = yield* makeImporter(root, development);
      yield* nextLaunch.load(destination);
      assert.deepEqual(yield* nextLaunch.take, Option.none());
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([false, true])(
  "imports the old origin from the independent copied profile (development: %s)",
  (development) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "paperplane-copied-storage-" });
      const name = development ? "rove-dev" : "rove-v2";
      const source = yield* writeProfile(root, name, development);
      yield* fs.writeFileString(path.join(root, name, "v1-local-storage-imported"), "");
      const destination = prepareProfileMigration({
        appDataDirectory: root,
        isDevelopment: development,
        platform: "linux",
      });
      const importer = yield* makeImporter(root, development);
      yield* importer.load(destination);
      assert.deepEqual(yield* importer.take, Option.some({ "prompt-draft": `draft-from-${name}` }));
      yield* importer.complete;
      assert.deepEqual(yield* fs.readFile(path.join(source.directory, "000002.log")), source.log);
      const next = yield* makeImporter(root, development);
      yield* next.load(destination);
      assert.deepEqual(yield* next.take, Option.none());
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("retries an unreadable legacy database without marking it imported", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "paperplane-local-storage-" });
    const source = yield* writeProfile(root, "rove-code", false);
    yield* fs.writeFileString(path.join(source.directory, "CURRENT"), "corrupt");
    const destination = path.join(root, "paperplane");
    yield* fs.makeDirectory(destination);
    const marker = path.join(destination, "paperplane-local-storage-imported");
    const importer = yield* makeImporter(root, false);
    yield* importer.load(destination);
    assert.deepEqual(yield* importer.take, Option.none());
    assert.isFalse(yield* fs.exists(marker));
    yield* fs.writeFileString(path.join(source.directory, "CURRENT"), "MANIFEST-000001\n");
    yield* importer.load(destination);
    assert.deepEqual(yield* importer.take, Option.some({ "prompt-draft": "draft-from-rove-code" }));
    yield* importer.complete;
    assert.isTrue(yield* fs.exists(marker));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
