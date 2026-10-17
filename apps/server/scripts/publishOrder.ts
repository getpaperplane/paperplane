import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

/**
 * Publishes every platform package at once, then the launcher, which must
 * never be installable before the executables it points to. When one platform
 * fails, the other uploads still finish rather than being interrupted: npm
 * never accepts the same version twice, and an interrupted upload may already
 * be live. The launcher is then skipped and the first failure is returned.
 */
export const publishPlatformsThenLauncher = <E, R, WaitE = never, WaitR = never>(input: {
  readonly platformTarballs: ReadonlyArray<string>;
  readonly launcherTarball: string;
  readonly publish: (tarball: string) => Effect.Effect<void, E, R>;
  readonly only?: "platforms" | "launcher" | "both";
  readonly waitForPlatforms?: Effect.Effect<void, WaitE, WaitR>;
}) =>
  Effect.gen(function* () {
    if (input.only !== "launcher") {
      const results = yield* Effect.all(input.platformTarballs.map(input.publish), {
        concurrency: "unbounded",
        mode: "result",
      });
      const failed = results.find(Result.isFailure);
      if (failed) {
        return yield* Effect.fail(failed.failure);
      }
    }
    if (input.only === "platforms") return;
    if (input.waitForPlatforms) yield* input.waitForPlatforms;
    yield* input.publish(input.launcherTarball);
  });
