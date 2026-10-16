import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect("identifies a failed source read and preserves its cause", () => {
  const sourceState = "/profiles/rove-code/Local State";
  const cause = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "readFileString",
    pathOrDescriptor: sourceState,
  });
  return Effect.gen(function* () {
    const error = yield* resolveUserDataPath({
      appDataDirectory: "/profiles",
      isDevelopment: false,
      platform: "win32",
    }).pipe(Effect.flip);
    assert.equal(error.operation, "read");
    assert.equal(error.resourcePath, sourceState);
    assert.equal(error.category, "PermissionDenied");
    assert.strictEqual(error.cause, cause);
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: (path) => Effect.succeed(path === sourceState),
        readFileString: () => Effect.fail(cause),
      }),
    ),
    Effect.provide(NodeServices.layer),
  );
});

it.effect.each([
  { sourceName: "rove-code", currentName: "rove-v2", isDevelopment: false },
  { sourceName: "rove-code-dev", currentName: "rove-dev", isDevelopment: true },
])(
  "preserves Windows credential keys from $sourceName without copying browser databases",
  ({ sourceName, currentName, isDevelopment }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "rove-v2-profile-" });
      const source = path.join(directory, sourceName);
      const destination = path.join(directory, currentName);
      const state = '{"os_crypt":{"encrypted_key":"test-encrypted-key"}}';
      yield* fs.makeDirectory(path.join(source, "IndexedDB"), { recursive: true });
      yield* fs.writeFileString(path.join(source, "Local State"), state);
      yield* fs.writeFileString(path.join(source, "IndexedDB", "LOCK"), "V1 owns this database");
      const userData = yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment,
        platform: "win32",
      });
      assert.equal(userData, destination);
      assert.equal(yield* fs.readFileString(path.join(destination, "Local State")), state);
      assert.equal(yield* fs.readFileString(path.join(source, "Local State")), state);
      assert.equal(
        yield* fs.readFileString(path.join(source, "IndexedDB", "LOCK")),
        "V1 owns this database",
      );
      assert.isFalse(yield* fs.exists(path.join(destination, "IndexedDB")));
      yield* fs.writeFileString(path.join(destination, "Local State"), "existing V2 state");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment,
        platform: "win32",
      });
      assert.equal(
        yield* fs.readFileString(path.join(destination, "Local State")),
        "existing V2 state",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([false, true])(
  "never copies credentials from upstream or the opposite mode (development: %s)",
  (isDevelopment) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "rove-v2-profile-" });
      const unrelatedNames = [
        "rove",
        "Rove Code (Alpha)",
        "Rove Code (Dev)",
        isDevelopment ? "rove-code" : "rove-code-dev",
      ];
      for (const name of unrelatedNames) {
        yield* fs.makeDirectory(path.join(directory, name), { recursive: true });
        yield* fs.writeFileString(path.join(directory, name, "Local State"), "unrelated keys");
      }
      const destination = yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment,
        platform: "win32",
      });
      assert.equal(destination, path.join(directory, isDevelopment ? "rove-dev" : "rove-v2"));
      assert.isFalse(yield* fs.exists(destination));
      for (const name of unrelatedNames) {
        assert.equal(
          yield* fs.readFileString(path.join(directory, name, "Local State")),
          "unrelated keys",
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["darwin", "linux"] as const)(
  "selects separate V2 profiles without opening legacy databases on %s",
  (platform) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "rove-v2-profile-" });
      yield* fs.makeDirectory(path.join(directory, "rove-code"));
      yield* fs.makeDirectory(path.join(directory, "rove-code-dev"));
      for (const isDevelopment of [false, true]) {
        const destination = yield* resolveUserDataPath({
          appDataDirectory: directory,
          isDevelopment,
          platform,
        });
        assert.equal(destination, path.join(directory, isDevelopment ? "rove-dev" : "rove-v2"));
        assert.isFalse(yield* fs.exists(destination));
      }
      assert.deepEqual((yield* fs.readDirectory(directory)).sort(), ["rove-code", "rove-code-dev"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
