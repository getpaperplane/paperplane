import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClientError from "effect/http/HttpClientError";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HostProcess from "@rove-code/shared/HostProcess";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

const decodeBatch = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      api_key: Schema.String,
      batch: Schema.Array(
        Schema.Struct({
          event: Schema.String,
          distinct_id: Schema.String,
          properties: Schema.Record(Schema.String, Schema.Unknown),
        }),
      ),
    }),
  ),
);

const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function fixture(
  options: {
    readonly env?: Record<string, string | number | boolean>;
    readonly enabled?: boolean;
    readonly status?: () => number;
    readonly response?: Effect.Effect<number>;
  } = {},
) {
  const requests: Array<{ url: string; payload: ReturnType<typeof decodeBatch> }> = [];
  const httpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      requests.push({ url: request.url, payload: decodeBatch(body) });
      const status = options.response ? yield* options.response : (options.status?.() ?? 200);
      return HttpClientResponse.fromWeb(request, new Response(null, { status }));
    }),
  );
  const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "rove-analytics-" });
  const settingsLayer = ServerSettings.layerTest({ telemetryEnabled: options.enabled ?? true });
  const layer = AnalyticsService.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(settingsLayer),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(HostProcess.Platform, "linux"),
        Layer.succeed(HostProcess.Architecture, "arm64"),
        ConfigProvider.layer(ConfigProvider.fromUnknown(options.env ?? {})),
      ),
    ),
  );
  return { requests, layer };
}

const SentBatch = Schema.fromJsonString(
  Schema.Struct({
    batch: Schema.Array(Schema.Struct({ uuid: Schema.String })),
  }),
);

/**
 * HTTP client that reads each batch, then fails as if the connection dropped
 * before the response arrived. PostHog stores these batches, so the server
 * must not send them forever.
 */
const layerAcceptThenFailClient = (batches: Array<ReadonlyArray<{ readonly uuid: string }>>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.body._tag === "Uint8Array") {
          const body = yield* Schema.decodeEffect(SentBatch)(
            new TextDecoder().decode(request.body.body),
          ).pipe(Effect.orDie);
          batches.push(body.batch);
        }
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: "connection reset" }),
        });
      }),
    ),
  );

it("retryDelayMs doubles from 2s and stays under the 5 minute cap", () => {
  assert.equal(AnalyticsService.retryDelayMs(1, 0), 1_000);
  assert.equal(AnalyticsService.retryDelayMs(2, 0.999_999), 4_000);
  assert.equal(AnalyticsService.retryDelayMs(30, 0), 150_000);
  assert.equal(AnalyticsService.retryDelayMs(30, 0.999_999), 300_000);
});

it.layer(NodeServices.layer)("AnalyticsService", (it) => {
  it.effect("a batch that keeps failing is retried with backoff, then dropped", () =>
    Effect.gen(function* () {
      const batches: Array<ReadonlyArray<{ readonly uuid: string }>> = [];
      const layerRuntime = AnalyticsService.layer.pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "rove-telemetry-retry-" }),
        ),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              ROVE_TELEMETRY_ENABLED: true,
              ROVE_POSTHOG_KEY: "phc_test_key",
              ROVE_POSTHOG_HOST: "http://localhost",
            }),
          ),
        ),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcess.Platform, "win32"),
            Layer.succeed(HostProcess.Architecture, "x64"),
            layerAcceptThenFailClient(batches),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        for (let index = 0; index < 20; index += 1) {
          yield* analytics.record("server.boot.heartbeat", { threadCount: index });
        }
        // Before the fix this loop sent the batch about once a second.
        for (let second = 0; second < 600; second += 1) {
          yield* TestClock.adjust("1 second");
        }
      }).pipe(Effect.provide(layerRuntime));

      assert.equal(batches.length, 5);
      const uuids = batches.map((batch) => batch.map((event) => event.uuid).join(","));
      assert.equal(new Set(uuids).size, 1, "every retry carries the same uuids");
      assert.equal(new Set(batches[0]?.map((event) => event.uuid)).size, 20);
    }),
  );

  it.effect("sends anonymous allowlisted metadata to Paperplane's ingestion host", () => {
    const f = fixture({ env: { ROVE_ANALYTICS_ENVIRONMENT: "test" } });
    return Effect.gen(function* () {
      const analytics = yield* AnalyticsService.AnalyticsService;
      yield* analytics.record("client.connected", {
        surface: "mobile",
        clientOs: "iOS",
        clientDeviceType: "phone",
        clientOsMajorVersion: 18,
        deviceModel: "Personal device",
        clientDeviceModel: "Personal device",
        prompt: "secret prompt",
        token: "secret token",
        threadId: "private-thread",
        $current_url: "https://secret.test",
        $set: { email: "secret@example.test" },
        $process_person_profile: true,
        $ip: "203.0.113.10",
      });
      yield* analytics.flush;
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0]?.url, "https://us.i.posthog.com/batch/");
      assert.equal(
        f.requests[0]?.payload.api_key,
        "phc_yeQwVXeqVTddxs65mQDciB89XFT3VdixFEyPuHdEbR9V",
      );
      const event = f.requests[0]?.payload.batch[0];
      assert.match(event?.distinct_id ?? "", /^[0-9a-f]{64}$/);
      assert.equal(event?.properties.$process_person_profile, false);
      assert.equal(event?.properties.$lib, "rove-server");
      assert.equal(event?.properties.$geoip_disable, true);
      assert.isNull(event?.properties.$ip);
      assert.notProperty(event?.properties ?? {}, "$set");
      assert.equal(event?.properties.analyticsEnvironment, "test");
      assert.equal(event?.properties.releaseChannel, "stable");
      assert.equal(event?.properties.clientOs, "iOS");
      assert.equal(event?.properties.clientOsMajorVersion, 18);
      assert.equal(event?.properties.serverOs, "Linux");
      assert.equal(event?.properties.serverArch, "arm64");
      assert.notInclude(serialize(f.requests), "secret");
      assert.notInclude(serialize(f.requests), "Personal device");
      assert.notInclude(serialize(f.requests), "private-thread");
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("only production client activity creates minimal installation profiles", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const analytics = yield* AnalyticsService.AnalyticsService;
      yield* analytics.record("server.boot.heartbeat", { threadCount: 12 });
      yield* analytics.record("provider.turn.completed", { provider: "pi" });
      yield* analytics.record("client.connected");
      yield* analytics.record("client.turn.requested");
      yield* analytics.flush;
      const events = f.requests.flatMap((r) => r.payload.batch);
      assert.deepEqual(
        events.map((e) => e.properties.$process_person_profile),
        [false, false, true, true],
      );
      assert.equal(new Set(events.map((e) => e.distinct_id)).size, 1);
      for (const event of events) {
        assert.equal(event.properties.analyticsEnvironment, "production");
        assert.notProperty(event.properties, "$set");
        assert.notProperty(event.properties, "$set_once");
        assert.notProperty(event.properties, "email");
        assert.notProperty(event.properties, "name");
      }
    }).pipe(Effect.provide(f.layer));
  });

  for (const environment of ["development", "test"] as const) {
    it.effect(`${environment} traffic never requests person profile creation`, () => {
      const f = fixture({ env: { NODE_ENV: environment } });
      return Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("client.connected");
        yield* analytics.record("client.feature.used", {
          feature: "terminal",
          action: "open",
          outcome: "succeeded",
        });
        yield* analytics.flush;
        for (const event of f.requests.flatMap((r) => r.payload.batch)) {
          assert.equal(event.properties.analyticsEnvironment, environment);
          assert.isFalse(event.properties.$process_person_profile);
        }
      }).pipe(Effect.provide(f.layer));
    });
  }

  it.effect("flush drains multiple bounded batches", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const analytics = yield* AnalyticsService.AnalyticsService;
      for (let index = 0; index < 45; index++) {
        yield* analytics.record("provider.turn.sent", { attachmentCount: index });
      }
      yield* analytics.flush;
      assert.deepEqual(
        f.requests.map((r) => r.payload.batch.length),
        [20, 20, 5],
      );
      assert.deepEqual(
        f.requests.flatMap((r) => r.payload.batch.map((e) => e.properties.attachmentCount)),
        Array.from({ length: 45 }, (_, index) => index),
      );
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("drops unknown events and invalid or unapproved properties", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const analytics = yield* AnalyticsService.AnalyticsService;
      yield* analytics.record("private.event", { prompt: "secret" });
      yield* analytics.record("provider.turn.sent", {
        provider: "pi",
        runtimeMode: "auto",
        attachmentCount: -1,
        model: "secret prompt with spaces",
        durationMs: Infinity,
        arbitrary: "secret",
      });
      yield* analytics.flush;
      assert.equal(f.requests[0]?.payload.batch.length, 1);
      const properties = f.requests[0]?.payload.batch[0]?.properties;
      assert.equal(properties?.provider, "pi");
      assert.equal(properties?.runtimeMode, "auto");
      assert.notProperty(properties ?? {}, "attachmentCount");
      assert.notProperty(properties ?? {}, "model");
      assert.notProperty(properties ?? {}, "durationMs");
      assert.notInclude(serialize(f.requests), "secret");
    }).pipe(Effect.provide(f.layer));
  });

  for (const [name, options] of [
    ["environment opt-out", { env: { ROVE_TELEMETRY_ENABLED: false } }],
    ["persisted preference opt-out", { enabled: false }],
  ] as const) {
    it.effect(`${name} prevents identity access and requests`, () => {
      const f = fixture(options);
      return Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* analytics.record("client.connected");
        yield* analytics.flush;
        assert.isFalse(yield* fs.exists(config.anonymousIdPath));
        assert.equal(f.requests.length, 0);
      }).pipe(Effect.provide(f.layer));
    });
  }

  it.effect("live opt-out discards queued events; opting back in records only new events", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const analytics = yield* AnalyticsService.AnalyticsService;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* analytics.record("client.connected");
      yield* settings.updateSettings({ telemetryEnabled: false });
      yield* analytics.flush;
      yield* analytics.record("client.thread.started");
      yield* settings.updateSettings({ telemetryEnabled: true });
      yield* analytics.record("client.turn.requested");
      yield* analytics.flush;
      assert.deepEqual(
        f.requests.flatMap((r) => r.payload.batch.map((e) => e.event)),
        ["client.turn.requested"],
      );
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("a failed in-flight batch cannot return after opt-out and opt-in", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const response = yield* Deferred.make<number>();
      let first = true;
      const f = fixture({
        response: Effect.gen(function* () {
          if (!first) return 200;
          first = false;
          yield* Deferred.succeed(started, undefined);
          return yield* Deferred.await(response);
        }),
      });
      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* analytics.record("client.connected");
        const pendingFlush = yield* analytics.flush.pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* settings.updateSettings({ telemetryEnabled: false });
        yield* analytics.flush;
        yield* settings.updateSettings({ telemetryEnabled: true });
        yield* analytics.record("client.turn.requested");
        yield* Deferred.succeed(response, 503);
        yield* Fiber.join(pendingFlush);
        yield* analytics.flush;
        assert.deepEqual(
          f.requests.map((r) => r.payload.batch.map((e) => e.event)),
          [["client.connected"], ["client.turn.requested"]],
        );
      }).pipe(Effect.provide(f.layer));
    }),
  );

  it.effect("the environment opt-out cannot be overridden by Settings", () => {
    const f = fixture({ env: { ROVE_TELEMETRY_ENABLED: false } });
    return Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ telemetryEnabled: true });
      const analytics = yield* AnalyticsService.AnalyticsService;
      yield* analytics.record("client.connected");
      yield* analytics.flush;
      assert.equal(f.requests.length, 0);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("retries failed batches without duplicating successfully delivered events", () => {
    let status = 503;
    const f = fixture({ status: () => status });
    return Effect.gen(function* () {
      const analytics = yield* AnalyticsService.AnalyticsService;
      yield* analytics.record("client.connected");
      yield* analytics.flush;
      status = 200;
      yield* analytics.flush;
      yield* analytics.flush;
      assert.equal(f.requests.length, 2);
      assert.deepEqual(f.requests[0]?.payload, f.requests[1]?.payload);
    }).pipe(Effect.provide(f.layer));
  });
});
