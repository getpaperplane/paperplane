/**
 * Installation-scoped PostHog telemetry service.
 *
 * Persists an installation-scoped anonymous identifier, buffers events in
 * memory, and flushes batches over Effect's HTTP client.
 *
 * @module AnalyticsService
 */
import { HostProcessArchitecture, HostProcessPlatform } from "@rove-code/shared/hostProcess";
import type { ClientOs } from "@rove-code/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { getTelemetryIdentifier } from "./Identify.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { sanitizeAnalyticsProperties } from "./AnalyticsPolicy.ts";

interface BufferedAnalyticsEvent {
  readonly event: string;
  readonly properties?: Readonly<Record<string, string | number | boolean>>;
  readonly capturedAt: string;
  readonly generation: number;
}

const TelemetryEnvConfig = Config.all({
  posthogKey: Config.String("ROVE_POSTHOG_KEY").pipe(
    Config.withDefault("phc_yeQwVXeqVTddxs65mQDciB89XFT3VdixFEyPuHdEbR9V"),
  ),
  posthogHost: Config.String("ROVE_POSTHOG_HOST").pipe(
    Config.withDefault("https://us.i.posthog.com"),
  ),
  enabled: Config.Boolean("ROVE_TELEMETRY_ENABLED").pipe(Config.withDefault(true)),
  environment: Config.Literals(
    ["production", "development", "test"],
    "ROVE_ANALYTICS_ENVIRONMENT",
  ).pipe(Config.option),
  nodeEnvironment: Config.String("NODE_ENV").pipe(Config.option),
  flushBatchSize: Config.Number("ROVE_TELEMETRY_FLUSH_BATCH_SIZE").pipe(Config.withDefault(20)),
  maxBufferedEvents: Config.Number("ROVE_TELEMETRY_MAX_BUFFERED_EVENTS").pipe(
    Config.withDefault(1_000),
  ),
  wslDistroName: Config.String("WSL_DISTRO_NAME").pipe(Config.option),
});

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** Record an anonymous event for best-effort buffered delivery. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;

    /** Flush all currently queued telemetry events. */
    readonly flush: Effect.Effect<void>;
  }
>()("@rove-code/server/telemetry/AnalyticsService") {
  /** No-op layer for callers that intentionally disable telemetry. */
  static readonly layerTest = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      record: () => Effect.void,
      flush: Effect.void,
    }),
  );
}

function serverOsFromNodePlatform(platform: string): ClientOs {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    case "android":
      return "Android";
    default:
      return "other";
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const telemetryConfig = yield* TelemetryEnvConfig;
  if (!telemetryConfig.enabled) {
    return AnalyticsService.of({ record: () => Effect.void, flush: Effect.void });
  }

  const httpClient = yield* HttpClient.HttpClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettingsService;
  // Cache the effect, not its result: opting out before the first event must
  // neither read nor create an installation identifier.
  const identityContext = yield* Effect.context<Effect.Services<typeof getTelemetryIdentifier>>();
  const identifier = yield* Effect.cached(
    getTelemetryIdentifier.pipe(Effect.provideContext(identityContext)),
  );
  const bufferRef = yield* Ref.make<ReadonlyArray<BufferedAnalyticsEvent>>([]);
  // A failed request can finish after opt-out and opt-in. Its old batch must
  // not be requeued into the newly opted-in buffer.
  let generation = 0;
  const discardBufferedEvents = Effect.sync(() => {
    generation++;
  }).pipe(Effect.andThen(Ref.set(bufferRef, [])));
  const settingsChanges = yield* settings.subscribeChanges;
  yield* settingsChanges.pipe(
    Stream.runForEach((next) => (next.telemetryEnabled ? Effect.void : discardBufferedEvents)),
    Effect.forkScoped,
  );
  const collectionEnabled = settings.getSettings.pipe(
    Effect.map((current) => current.telemetryEnabled),
    // Privacy wins over delivery if settings cannot be read.
    Effect.orElseSucceed(() => false),
  );
  const analyticsEnvironment = Option.getOrElse(telemetryConfig.environment, () =>
    Option.getOrUndefined(telemetryConfig.nodeEnvironment) === "test"
      ? "test"
      : serverConfig.devUrl ||
          Option.getOrUndefined(telemetryConfig.nodeEnvironment) === "development"
        ? "development"
        : "production",
  );
  const releaseChannel = packageJson.version.includes("nightly")
    ? "nightly"
    : packageJson.version.includes("preview")
      ? "preview"
      : "stable";
  const clientType = serverConfig.mode === "desktop" ? "desktop-app" : "cli-web-client";
  const hostPlatform = yield* HostProcessPlatform;
  const hostArchitecture = yield* HostProcessArchitecture;

  const enqueueBufferedEvent = (
    event: string,
    eventGeneration: number,
    properties?: Readonly<Record<string, string | number | boolean>>,
  ) =>
    Effect.flatMap(DateTime.now, (now) =>
      Ref.modify(bufferRef, (current) => {
        const appended = [
          ...current,
          {
            event,
            ...(properties ? { properties } : undefined),
            capturedAt: DateTime.formatIso(now),
            generation: eventGeneration,
          } satisfies BufferedAnalyticsEvent,
        ];

        const next =
          appended.length > telemetryConfig.maxBufferedEvents
            ? appended.slice(appended.length - telemetryConfig.maxBufferedEvents)
            : appended;

        return [
          {
            size: next.length,
            dropped: next.length !== appended.length,
          } as const,
          next,
        ] as const;
      }),
    );

  const sendBatch = Effect.fn("AnalyticsService.sendBatch")(function* (
    events: ReadonlyArray<BufferedAnalyticsEvent>,
  ) {
    if (!(yield* collectionEnabled)) {
      yield* discardBufferedEvents;
      return;
    }
    const batchGeneration = generation;
    const currentEvents = events.filter((event) => event.generation === batchGeneration);
    if (currentEvents.length === 0) return;
    const distinctId = yield* identifier;
    if (!distinctId) return;
    if (!(yield* collectionEnabled) || generation !== batchGeneration) return;

    const payload = {
      api_key: telemetryConfig.posthogKey,
      batch: currentEvents.map((event) => ({
        event: event.event,
        distinct_id: distinctId,
        properties: {
          ...event.properties,
          // Only real client activity creates a pseudonymous installation
          // profile. Boot heartbeats and dev/test runs must not inflate Persons.
          $process_person_profile:
            analyticsEnvironment === "production" && event.event.startsWith("client."),
          $geoip_disable: true,
          $ip: null,
          $lib: "rove-server",
          analyticsEnvironment,
          releaseChannel,
          platform: hostPlatform,
          wsl: Option.isSome(telemetryConfig.wslDistroName),
          arch: hostArchitecture,
          roveVersion: packageJson.version,
          clientType,
          serverOs: serverOsFromNodePlatform(hostPlatform),
          serverArch: hostArchitecture,
          serverWsl: Option.isSome(telemetryConfig.wslDistroName),
          serverAppVersion: packageJson.version,
          serverMode: serverConfig.mode,
        },
        timestamp: event.capturedAt,
      })),
    };

    yield* HttpClientRequest.post(`${telemetryConfig.posthogHost}/batch/`).pipe(
      HttpClientRequest.bodyJson(payload),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
    );
  });

  const flush: AnalyticsService["Service"]["flush"] = Effect.gen(function* () {
    while (true) {
      if (!(yield* collectionEnabled)) {
        yield* discardBufferedEvents;
        return;
      }
      const batch = yield* Ref.modify(bufferRef, (current) => {
        if (current.length === 0) {
          return [[] as ReadonlyArray<BufferedAnalyticsEvent>, current] as const;
        }
        const nextBatch = current.slice(0, telemetryConfig.flushBatchSize);
        const remaining = current.slice(nextBatch.length);
        return [nextBatch, remaining] as const;
      });

      if (batch.length === 0) {
        return;
      }

      yield* sendBatch(batch).pipe(
        Effect.catch((error) =>
          Ref.update(bufferRef, (current) =>
            [...batch.filter((event) => event.generation === generation), ...current].slice(
              -telemetryConfig.maxBufferedEvents,
            ),
          ).pipe(Effect.flatMap(() => Effect.fail(error))),
        ),
      );
    }
  }).pipe(Effect.catch((cause) => Effect.logError("Failed to flush telemetry", { cause })));

  const record: AnalyticsService["Service"]["record"] = Effect.fn("AnalyticsService.record")(
    function* (event, properties) {
      const safeProperties = sanitizeAnalyticsProperties(event, properties);
      if (safeProperties === undefined) return;
      const eventGeneration = generation;
      if (!(yield* collectionEnabled)) {
        yield* discardBufferedEvents;
        return;
      }

      const enqueueResult = yield* enqueueBufferedEvent(event, eventGeneration, safeProperties);
      if (enqueueResult.dropped) {
        yield* Effect.logDebug("analytics buffer full; dropping oldest event", {
          size: enqueueResult.size,
          event,
        });
      }
    },
  );

  // Idle hosts should not materialize settings (and provider secrets) every
  // second. Explicit flush still enforces opt-out even with a batch in flight.
  yield* Effect.forever(
    Effect.sleep(1000).pipe(
      Effect.flatMap(() => Ref.get(bufferRef)),
      Effect.flatMap((events) => (events.length === 0 ? Effect.void : flush)),
    ),
    { disableYield: true },
  ).pipe(Effect.forkScoped);

  yield* Effect.addFinalizer(() => flush);

  return AnalyticsService.of({ record, flush });
});

export const layer = Layer.effect(AnalyticsService, make);

export const layerTest = AnalyticsService.layerTest;
