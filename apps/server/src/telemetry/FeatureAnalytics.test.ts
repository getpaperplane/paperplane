import { assert, it } from "@effect/vitest";
import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@rove-code/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import { AnalyticsService } from "./AnalyticsService.ts";
import { makeFeatureAnalytics } from "./FeatureAnalytics.ts";

const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function fixture() {
  const events: Array<{
    event: string;
    properties: Parameters<AnalyticsService["Service"]["record"]>[1];
  }> = [];
  const analytics = AnalyticsService.of({
    record: (event, properties) =>
      Effect.sync(() => {
        events.push({ event, properties });
      }),
    flush: Effect.void,
  });
  return { events, analytics };
}

it.effect("records operation outcomes and timing without inspecting results or errors", () =>
  Effect.gen(function* () {
    const f = fixture();
    const observe = makeFeatureAnalytics(f.analytics, { surface: "web", clientOs: "Linux" });
    const result = yield* observe(
      WS_METHODS.terminalOpen,
      Effect.gen(function* () {
        yield* TestClock.adjust(125);
        return { cwd: "/secret/path", output: "private contents" };
      }),
    );
    const error = new Error("private command failed in /secret/path");
    const failed = yield* observe(WS_METHODS.vcsCreateWorktree, Effect.fail(error)).pipe(
      Effect.result,
    );
    assert.deepEqual(result, { cwd: "/secret/path", output: "private contents" });
    assert.equal(failed._tag, "Failure");
    if (failed._tag === "Failure") assert.equal(failed.failure, error);
    assert.deepEqual(
      f.events.map((e) => e.properties),
      [
        {
          surface: "web",
          clientOs: "Linux",
          feature: "terminal",
          action: "open",
          outcome: "succeeded",
          durationMs: 125,
        },
        {
          surface: "web",
          clientOs: "Linux",
          feature: "worktree",
          action: "create",
          outcome: "failed",
          durationMs: 0,
        },
      ],
    );
    assert.notInclude(serialize(f.events), "secret");
    assert.notInclude(serialize(f.events), "private");
  }),
);

it.effect("deduplicates read-heavy adoption per connection without mixing client metadata", () =>
  Effect.gen(function* () {
    const f = fixture();
    const web = makeFeatureAnalytics(f.analytics, { surface: "web" });
    const mobile = makeFeatureAnalytics(f.analytics, { surface: "mobile" });
    for (let index = 0; index < 5; index++) {
      yield* web(ORCHESTRATION_WS_METHODS.searchThreads, Effect.succeed([]));
    }
    yield* mobile(ORCHESTRATION_WS_METHODS.searchThreads, Effect.succeed([]));
    assert.deepEqual(
      f.events.map((e) => e.properties?.surface),
      ["web", "mobile"],
    );
  }),
);

it.effect("never tracks input, resize, polling, or unknown methods", () =>
  Effect.gen(function* () {
    const f = fixture();
    const observe = makeFeatureAnalytics(f.analytics, {});
    for (const method of [
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalResize,
      WS_METHODS.deviceAction,
      WS_METHODS.previewReportStatus,
      WS_METHODS.pullRequestsList,
      "private.method",
    ]) {
      assert.equal(yield* observe(method, Effect.succeed("secret")), "secret");
    }
    assert.deepEqual(f.events, []);
  }),
);

it.effect("records cancelled operations without changing interruption", () =>
  Effect.gen(function* () {
    const f = fixture();
    const observe = makeFeatureAnalytics(f.analytics, {});
    const started = yield* Deferred.make<void>();
    const fiber = yield* observe(
      WS_METHODS.vcsCreateWorktree,
      Effect.andThen(Deferred.succeed(started, undefined), Effect.never),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    assert.equal(f.events[0]?.properties?.outcome, "cancelled");
  }),
);

it.effect("telemetry failures cannot fail a product operation", () =>
  Effect.gen(function* () {
    const observe = makeFeatureAnalytics(
      AnalyticsService.of({ record: () => Effect.die("unavailable"), flush: Effect.void }),
      {},
    );
    assert.equal(yield* observe(WS_METHODS.terminalOpen, Effect.succeed("ok")), "ok");
  }),
);
