import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect("preserves inspection failures rather than starting with an empty profile", () => {
  const destination = "/profiles/paperplane";
  const cause = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "exists",
    pathOrDescriptor: destination,
  });
  return Effect.gen(function* () {
    const error = yield* resolveUserDataPath({
      appDataDirectory: "/profiles",
      isDevelopment: false,
      platform: "win32",
    }).pipe(Effect.flip);
    assert.equal(error.operation, "inspect");
    assert.equal(error.resourcePath, destination);
    assert.equal(error.category, "PermissionDenied");
    assert.strictEqual(error.cause, cause);
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({ exists: () => Effect.fail(cause) }),
    ),
    Effect.provide(NodeServices.layer),
  );
});

it.effect.each([false, true])(
  "uses the existing Paperplane profile (development: %s)",
  (isDevelopment) =>
    Effect.gen(function* () {
      const destination = yield* resolveUserDataPath({
        appDataDirectory: "/profiles",
        isDevelopment,
        platform: "linux",
      });
      assert.equal(destination, `/profiles/${isDevelopment ? "paperplane-dev" : "paperplane"}`);
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({ exists: () => Effect.succeed(true) }),
      ),
      Effect.provide(NodeServices.layer),
    ),
);
