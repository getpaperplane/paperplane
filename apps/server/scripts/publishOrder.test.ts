import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Latch from "effect/Latch";

import { publishPlatformsThenLauncher } from "./publishOrder.ts";

const platformTarballs = ["a.tgz", "b.tgz", "c.tgz"];
const launcherTarball = "rove.tgz";

// A fake publish that records when each upload starts and ends. Platform
// uploads only end once every platform upload has started, so they have to
// run at the same time. `failing` fails as soon as it starts.
const fakePublish = Effect.fn("fakePublish")(function* (failing?: string) {
  const events: Array<string> = [];
  const allStarted = yield* Latch.make();
  let started = 0;
  const publish = (tarball: string) =>
    Effect.gen(function* () {
      events.push(`start ${tarball}`);
      if (tarball === launcherTarball) return;
      started += 1;
      if (started === platformTarballs.length) yield* allStarted.open;
      if (tarball === failing) return yield* Effect.fail(`${tarball} failed`);
      yield* allStarted.await;
      events.push(`end ${tarball}`);
    });
  return { events, publish };
});

it.effect("publishes the platform packages at once and the launcher last", () =>
  Effect.gen(function* () {
    const { events, publish } = yield* fakePublish();

    yield* publishPlatformsThenLauncher({
      platformTarballs,
      launcherTarball,
      publish,
      waitForPlatforms: Effect.sync(() => {
        assert.includeMembers(events, ["end a.tgz", "end b.tgz", "end c.tgz"]);
        events.push("registry verified");
      }),
    });

    assert.deepStrictEqual(events.slice(0, 3).toSorted(), [
      "start a.tgz",
      "start b.tgz",
      "start c.tgz",
    ]);
    assert.strictEqual(events.at(-2), "registry verified");
    assert.strictEqual(events.at(-1), `start ${launcherTarball}`);
  }),
);

it.effect("platform-only publishing neither waits for npm nor publishes the launcher", () =>
  Effect.gen(function* () {
    const { events, publish } = yield* fakePublish();
    yield* publishPlatformsThenLauncher({
      platformTarballs,
      launcherTarball,
      publish,
      only: "platforms",
      waitForPlatforms: Effect.die("must not wait"),
    });
    assert.includeMembers(events, ["end a.tgz", "end b.tgz", "end c.tgz"]);
    assert.notInclude(events, `start ${launcherTarball}`);
  }),
);

it.effect("launcher-only publishing waits for npm without republishing platforms", () =>
  Effect.gen(function* () {
    const events: Array<string> = [];
    yield* publishPlatformsThenLauncher({
      platformTarballs,
      launcherTarball,
      only: "launcher",
      waitForPlatforms: Effect.sync(() => {
        events.push("npm serves all platforms");
      }),
      publish: (tarball) =>
        Effect.sync(() => {
          events.push(tarball);
        }),
    });
    assert.deepStrictEqual(events, ["npm serves all platforms", launcherTarball]);
  }),
);

it.effect("never publishes the launcher when registry verification fails", () =>
  Effect.gen(function* () {
    const { events, publish } = yield* fakePublish();
    const exit = yield* Effect.exit(
      publishPlatformsThenLauncher({
        platformTarballs,
        launcherTarball,
        publish,
        waitForPlatforms: Effect.fail("registry timeout"),
      }),
    );
    assert.deepStrictEqual(exit, Exit.fail("registry timeout"));
    assert.includeMembers(events, ["end a.tgz", "end b.tgz", "end c.tgz"]);
    assert.notInclude(events, `start ${launcherTarball}`);
  }),
);

it.effect("finishes the other uploads and skips the launcher when one fails", () =>
  Effect.gen(function* () {
    const { events, publish } = yield* fakePublish("b.tgz");

    const exit = yield* Effect.exit(
      publishPlatformsThenLauncher({ platformTarballs, launcherTarball, publish }),
    );

    assert.deepStrictEqual(exit, Exit.fail("b.tgz failed"));
    assert.includeMembers(events, ["end a.tgz", "end c.tgz"]);
    assert.notInclude(events, `start ${launcherTarball}`);
  }),
);
