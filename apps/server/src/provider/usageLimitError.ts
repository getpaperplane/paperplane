import { ProviderUsageLimit } from "./PiUsageLimits.ts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const decodeStructuredError = Schema.decodeUnknownOption(
  Schema.Struct({
    error: Schema.Struct({
      code: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
      resets_at: Schema.optional(Schema.Number),
      resets_in_seconds: Schema.optional(Schema.Number),
    }),
  }),
);

/** Subscription windows are at most weekly; anything later is a misparsed date. */
const MAX_RESET_HORIZON_MS = 8 * 86400000;
/** A time-only reset this recently passed means the provider reported late, not "tomorrow". */
const LATE_OBSERVATION_GRACE_MS = 3600000;

function futureReset(resetMs: number | null, observedMs: number): string | null {
  return resetMs !== null &&
    Number.isFinite(resetMs) &&
    resetMs > observedMs &&
    resetMs <= observedMs + MAX_RESET_HORIZON_MS
    ? DateTime.formatIso(DateTime.makeUnsafe(resetMs))
    : null;
}

/**
 * Reads an upstream `{ error: { type | code, resets_at | resets_in_seconds } }`
 * body, such as Codex's HTTP 429 body or its WebSocket `error` event.
 */
export function usageLimitFromErrorPayload(
  payload: unknown,
  observedAt: string,
): ProviderUsageLimit | null {
  const observedMs = Date.parse(observedAt);
  const decoded = decodeStructuredError(payload);
  if (!Number.isFinite(observedMs) || Option.isNone(decoded)) return null;
  const error = decoded.value.error;
  if (!/^(?:usage_limit_reached|rate_limit_exceeded)$/.test(error.code ?? error.type ?? ""))
    return null;
  const resetMs =
    error.resets_at !== undefined
      ? error.resets_at * 1000
      : error.resets_in_seconds !== undefined
        ? observedMs + error.resets_in_seconds * 1000
        : null;
  return { resetAt: futureReset(resetMs, observedMs) };
}

/** Resolve CLI wall-clock resets without assuming the host timezone or a fixed DST offset. */
function wallClockReset(message: string, observedMs: number): number | null {
  const reset = /\breset(?:s)?(?:\s+at)?\s+(.+?)\s*\(([^()]+)\)/i.exec(message);
  if (!reset) return null;
  const time = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s+on)?$/i.exec(
    reset[1]!
      .replace(
        /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:,?\s+\d{4})?,?\s*/i,
        "",
      )
      .trim(),
  );
  if (!time) return null;
  let hour = Number(time[1]);
  const minute = Number(time[2] ?? 0);
  if (minute > 59 || (time[3] ? hour < 1 || hour > 12 : hour > 23)) return null;
  if (time[3]) hour = (hour % 12) + (time[3].toLowerCase() === "pm" ? 12 : 0);
  try {
    const format = new Intl.DateTimeFormat("en-US", {
      timeZone: reset[2]!.trim(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const localEpoch = (ms: number) => {
      const parts = format.formatToParts(ms);
      const part = (type: Intl.DateTimeFormatPartTypes) =>
        Number(parts.find((p) => p.type === type)!.value);
      return Date.UTC(
        part("year"),
        part("month") - 1,
        part("day"),
        part("hour"),
        part("minute"),
        part("second"),
      );
    };
    const today = DateTime.toPartsUtc(DateTime.makeUnsafe(localEpoch(observedMs)));
    const date =
      /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/i.exec(
        reset[1]!,
      );
    const month = date
      ? "jan feb mar apr may jun jul aug sep oct nov dec".split(" ").indexOf(date[1]!.toLowerCase())
      : today.month - 1;
    const day = date ? Number(date[2]) : today.day;
    const year = date?.[3] ? Number(date[3]) : today.year;
    // Daily times roll over locally (not by adding 24h to a UTC instant).
    // A month/day without a year similarly refers to the next annual occurrence.
    for (let next = 0; next < (date?.[3] ? 1 : 2); next++) {
      if (!date && next === 1) {
        const stated = Date.UTC(year, month, day, hour, minute);
        const sinceStated = localEpoch(observedMs) - stated;
        if (sinceStated >= 0 && sinceStated < LATE_OBSERVATION_GRACE_MS) return null;
      }
      const target = Date.UTC(
        year + (date ? next : 0),
        month,
        day + (date ? 0 : next),
        hour,
        minute,
      );
      const targetDate = DateTime.toPartsUtc(DateTime.makeUnsafe(target));
      if (date && (targetDate.month - 1 !== month || targetDate.day !== day)) return null;
      const matches: number[] = [];
      // Probe both sides of transitions. Verify candidates to reject nonexistent local times
      // and choose the next future occurrence when a fall-back hour occurs twice.
      for (const delta of [-36, 0, 36]) {
        const probe = target + delta * 3600000;
        const candidate = target - (localEpoch(probe) - probe);
        if (candidate > observedMs && localEpoch(candidate) === target) matches.push(candidate);
      }
      if (matches.length) return Math.min(...matches);
    }
  } catch {
    // Invalid/unsupported timezone: keep the limit classification, not an invented reset.
  }
  return null;
}

export function usageLimitFromError(
  message: string,
  observedAt: string,
): ProviderUsageLimit | null {
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return null;
  if (
    /\b(?:usage_not_included|insufficient_quota|billing|payment required|subscription required|authentication|unauthorized)\b/i.test(
      message,
    )
  )
    return null;
  try {
    const payload: unknown = JSON.parse(message);
    if (Option.isSome(decodeStructuredError(payload)))
      return usageLimitFromErrorPayload(payload, observedAt);
  } catch {
    // Pi's SDK replaces the upstream JSON with a human-readable limit message.
  }
  if (
    !/\b(?:usage limit|rate limit|usage_limit_reached|rate_limit_exceeded|(?:\d+-hour|session|weekly|opus|sonnet)\s+limit reached|hit your (?!(?:[\w-]+\s+){0,4}(?:context|token|length|size)\b)(?:[\w-]+\s+){0,4}limit|your limit will reset)\b/i.test(
      message,
    )
  )
    return null;
  let resetMs: number | null = null;
  const duration =
    /(?:try again in|resets? in)\s*(~)?\s*((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|h|minutes?|mins?|m|seconds?|secs?|s)\s*)+)/i.exec(
      message,
    );
  if (duration) {
    let delayMs = 0;
    for (const part of duration[2]!.matchAll(
      /(\d+(?:\.\d+)?)\s*(days?|d|hours?|h|minutes?|mins?|m|seconds?|secs?|s)/gi,
    )) {
      const unit = part[2]!.toLowerCase()[0];
      delayMs +=
        Number(part[1]) *
        (unit === "d" ? 86400000 : unit === "h" ? 3600000 : unit === "m" ? 60000 : 1000);
    }
    if (delayMs > 0) resetMs = observedMs + delayMs + (duration[1] ? 60000 : 0);
  }
  if (resetMs === null) {
    const epoch = /\busage limit reached\s*\|\s*(\d+(?:\.\d+)?)\b/i.exec(message);
    resetMs = epoch ? Number(epoch[1]) * 1000 : wallClockReset(message, observedMs);
  }
  return { resetAt: futureReset(resetMs, observedMs) };
}

/**
 * Reads a provider HTTP 429. The body covers Codex's `usage_limit_reached`;
 * Anthropic subscriptions only report the rejected window and its reset in
 * `anthropic-ratelimit-unified-[<claim>-]status` / `-reset` headers.
 */
export function usageLimitFromHttpError(
  headers: Headers,
  body: unknown,
  observedAt: string,
): ProviderUsageLimit | null {
  const fromBody = usageLimitFromErrorPayload(body, observedAt);
  if (fromBody !== null && fromBody.resetAt !== null) return fromBody;
  const observedMs = Date.parse(observedAt);
  let rejected = false;
  const resets: number[] = [];
  for (const [name, value] of headers) {
    const claim = /^anthropic-ratelimit-unified-(?:(.+)-)?status$/.exec(name);
    if (claim === null || value.trim().toLowerCase() !== "rejected") continue;
    rejected = true;
    const prefix = claim[1] === undefined ? "" : `${claim[1]}-`;
    const reset = Number(headers.get(`anthropic-ratelimit-unified-${prefix}reset`)) * 1000;
    if (Number.isFinite(reset) && reset > observedMs) resets.push(reset);
  }
  if (!rejected || !Number.isFinite(observedMs)) return fromBody;
  return {
    resetAt: resets.length === 0 ? null : futureReset(Math.max(...resets), observedMs),
  };
}
