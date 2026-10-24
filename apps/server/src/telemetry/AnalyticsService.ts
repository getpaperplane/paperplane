/**
 * Anonymous PostHog telemetry service.
 *
 * Persists an installation-scoped anonymous identifier, buffers events in
 * memory, and flushes batches over Effect's HTTP client. A failed batch is
 * retried with backoff and dropped after a few tries. Each event carries a
 * uuid, so PostHog can tell a retried copy from a new event.
 *
 * @module AnalyticsService
 */
import * as HostProcess from "@getpaperplane/shared/HostProcess";
import type { ClientOs } from "@getpaperplane/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { getTelemetryIdentifier } from "./Identify.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { sanitizeAnalyticsProperties } from "./AnalyticsPolicy.ts";

interface BufferedAnalyticsEvent {
  readonly uuid: string;
  readonly event: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly capturedAt: string;
  readonly generation: number;
}

interface DeliveryState {
  /** Batch that failed last. It is sent again before newer events. */
  readonly failedBatch: ReadonlyArray<BufferedAnalyticsEvent>;
  /** Failed sends of `failedBatch`. */
  readonly batchAttempts: number;
  /** Failed sends since the last success. Sets the backoff delay. */
  readonly failures: number;
  /** The background flush does not send before this time (epoch ms). */
  readonly retryAt: number;
}

const FLUSH_INTERVAL_MS = 1_000;
// A hung send would hold the flush lock, and with it the shutdown flush.
const SEND_TIMEOUT = "10 seconds";
const MAX_BATCH_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 300_000;

/**
 * Delay before the next send after `failures` consecutive failed sends. The
 * ceiling doubles from 2s up to 5 minutes, and the delay is a random point in
 * its upper half. `random` is in [0, 1).
 */
export function retryDelayMs(failures: number, random: number): number {
  const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (failures - 1));
  return Math.round(ceiling / 2 + (ceiling / 2) * random);
}

const TelemetryEnvConfig = Config.all({
  posthogKey: Config.String("PAPERPLANE_POSTHOG_KEY").pipe(
    Config.withDefault("phc_yeQwVXeqVTddxs65mQDciB89XFT3VdixFEyPuHdEbR9V"),
  ),
  posthogHost: Config.String("PAPERPLANE_POSTHOG_HOST").pipe(
    Config.withDefault("https://us.i.posthog.com"),
  ),
  enabled: Config.Boolean("PAPERPLANE_TELEMETRY_ENABLED").pipe(Config.withDefault(true)),
  environment: Config.Literals(
    ["production", "development", "test"],
    "PAPERPLANE_ANALYTICS_ENVIRONMENT",
  ).pipe(Config.option),
  nodeEnvironment: Config.String("NODE_ENV").pipe(Config.option),
  flushBatchSize: Config.Number("PAPERPLANE_TELEMETRY_FLUSH_BATCH_SIZE").pipe(
    Config.withDefault(20),
  ),
  maxBufferedEvents: Config.Number("PAPERPLANE_TELEMETRY_MAX_BUFFERED_EVENTS").pipe(
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
>()("@getpaperplane/server/telemetry/AnalyticsService") {
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
  const httpClient = yield* HttpClient.HttpClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  if (!telemetryConfig.enabled) {
    return AnalyticsService.of({ record: () => Effect.void, flush: Effect.void });
  }
  const settings = yield* ServerSettingsService;
  // Cache the effect, not an eagerly-created installation identifier.
  const identityContext = yield* Effect.context<Effect.Services<typeof getTelemetryIdentifier>>();
  const identifier = yield* Effect.cached(
    getTelemetryIdentifier.pipe(Effect.provideContext(identityContext)),
  );
  const crypto = yield* Crypto.Crypto;
  const bufferRef = yield* Ref.make<ReadonlyArray<BufferedAnalyticsEvent>>([]);
  const deliveryRef = yield* Ref.make<DeliveryState>({
    failedBatch: [],
    batchAttempts: 0,
    failures: 0,
    retryAt: 0,
  });
  let generation = 0;
  const discardBufferedEvents = Effect.sync(() => {
    generation++;
  }).pipe(
    Effect.andThen(Ref.set(bufferRef, [])),
    Effect.andThen(
      Ref.set(deliveryRef, { failedBatch: [], batchAttempts: 0, failures: 0, retryAt: 0 }),
    ),
  );
  const settingsChanges = yield* settings.subscribeChanges;
  yield* settingsChanges.pipe(
    Stream.runForEach((next) => (next.telemetryEnabled ? Effect.void : discardBufferedEvents)),
    Effect.forkScoped,
  );
  const collectionEnabled = settings.getSettings.pipe(
    Effect.map((current) => current.telemetryEnabled),
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

  // The background flush and the shutdown flush must not send the same batch at once.
  const flushLock = yield* Semaphore.make(1);
  const clientType = serverConfig.mode === "desktop" ? "desktop-app" : "cli-web-client";
  const hostPlatform = yield* HostProcess.Platform;
  const hostArchitecture = yield* HostProcess.Architecture;

  const enqueueBufferedEvent = (
    uuid: string,
    event: string,
    eventGeneration: number,
    properties?: Readonly<Record<string, unknown>>,
  ) =>
    Effect.flatMap(DateTime.now, (now) =>
      Ref.modify(bufferRef, (current) => {
        const appended = [
          ...current,
          {
            uuid,
            event,
            ...(properties ? { properties } : {}),
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
    if (!distinctId || !(yield* collectionEnabled) || generation !== batchGeneration) return;

    const payload = {
      api_key: telemetryConfig.posthogKey,
      batch: currentEvents.map((event) => ({
        uuid: event.uuid,
        event: event.event,
        distinct_id: distinctId,
        properties: {
          ...event.properties,
          $process_person_profile:
            analyticsEnvironment === "production" && event.event.startsWith("client."),
          $geoip_disable: true,
          $ip: null,
          $lib: "paperplane-server",
          analyticsEnvironment,
          releaseChannel,
          platform: hostPlatform,
          wsl: Option.isSome(telemetryConfig.wslDistroName),
          arch: hostArchitecture,
          paperplaneCodeVersion: packageJson.version,
          paperplaneVersion: packageJson.version,
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
      Effect.timeout(SEND_TIMEOUT),
    );
  });

  const takeBatch = Ref.modify(bufferRef, (current) => {
    const nextBatch = current.slice(0, telemetryConfig.flushBatchSize);
    return [nextBatch, current.slice(nextBatch.length)] as const;
  });

  // Sends batches until the buffer is empty or a send fails. A failed batch is
  // kept for the next flush, and dropped after MAX_BATCH_ATTEMPTS failed sends.
  const flushBatches = Effect.gen(function* () {
    while (true) {
      if (!(yield* collectionEnabled)) {
        yield* discardBufferedEvents;
        return;
      }
      const batchGeneration = generation;
      const delivery = yield* Ref.get(deliveryRef);
      const batch = delivery.failedBatch.length > 0 ? delivery.failedBatch : yield* takeBatch;
      if (batch.length === 0) {
        return;
      }

      const sent = yield* Effect.result(sendBatch(batch));
      if (!(yield* collectionEnabled) || generation !== batchGeneration) return;
      if (Result.isSuccess(sent)) {
        yield* Ref.set(deliveryRef, { failedBatch: [], batchAttempts: 0, failures: 0, retryAt: 0 });
        continue;
      }

      const failures = delivery.failures + 1;
      const batchAttempts = delivery.batchAttempts + 1;
      const retryAt = (yield* Clock.currentTimeMillis) + retryDelayMs(failures, yield* Random.next);
      if (batchAttempts < MAX_BATCH_ATTEMPTS) {
        yield* Ref.set(deliveryRef, { failedBatch: batch, batchAttempts, failures, retryAt });
        yield* Effect.logDebug("Failed to send telemetry batch; will retry", {
          attempt: batchAttempts,
          cause: sent.failure,
        });
        return;
      }
      yield* Ref.set(deliveryRef, { failedBatch: [], batchAttempts: 0, failures, retryAt });
      yield* Effect.logWarning("Dropped telemetry batch after repeated send failures", {
        events: batch.length,
        attempts: batchAttempts,
        cause: sent.failure,
      });
      return;
    }
  }).pipe(flushLock.withPermit);

  // Opt-out must discard a queued or in-flight generation without waiting for HTTP.
  const flush: AnalyticsService["Service"]["flush"] = collectionEnabled.pipe(
    Effect.flatMap((enabled) => (enabled ? flushBatches : discardBufferedEvents)),
  );

  const pending = yield* Queue.sliding<void>(1);
  const flushWhenDue = Effect.gen(function* () {
    const { retryAt } = yield* Ref.get(deliveryRef);
    if ((yield* Clock.currentTimeMillis) >= retryAt) {
      yield* flush;
    }
  });

  const record: AnalyticsService["Service"]["record"] = Effect.fn("AnalyticsService.record")(
    function* (event, properties) {
      const safeProperties = sanitizeAnalyticsProperties(event, properties);
      if (safeProperties === undefined) return;
      const eventGeneration = generation;
      if (!(yield* collectionEnabled)) {
        yield* discardBufferedEvents;
        return;
      }

      // Telemetry is best effort: an event without a uuid is not sent. The
      // Node implementation throws (a defect) rather than failing, so catch both.
      const uuid = yield* Effect.exit(crypto.randomUUIDv7());
      if (Exit.isFailure(uuid)) return;

      const enqueueResult = yield* enqueueBufferedEvent(
        uuid.value,
        event,
        eventGeneration,
        safeProperties,
      );
      yield* Queue.offer(pending, undefined);
      if (enqueueResult.dropped) {
        yield* Effect.logDebug("analytics buffer full; dropping oldest event", {
          size: enqueueResult.size,
          event,
        });
      }
    },
  );

  yield* Effect.forever(
    Effect.gen(function* () {
      const events = yield* Ref.get(bufferRef);
      const delivery = yield* Ref.get(deliveryRef);
      if (events.length === 0 && delivery.failedBatch.length === 0) {
        yield* Queue.take(pending);
        return;
      }
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(Math.max(FLUSH_INTERVAL_MS, delivery.retryAt - now));
      yield* flushWhenDue;
    }),
    {
      disableYield: true,
    },
  ).pipe(Effect.forkScoped);

  yield* Effect.addFinalizer(() => flush);

  return AnalyticsService.of({ record, flush });
});

export const layer = Layer.effect(AnalyticsService, make);

const layerTest = AnalyticsService.layerTest;
