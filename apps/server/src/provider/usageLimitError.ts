import type { ProviderUsageLimit } from "./PiUsageLimits.ts";
import { piQuotaStatus } from "./PiUsageLimits.ts";
import type { UsageLimitStatus } from "./usageLimitStatus.ts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const ErrorDetails = Schema.Struct({
  code: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  resets_at: Schema.optional(Schema.Number),
  resets_in_seconds: Schema.optional(Schema.Number),
});
const decodeStructuredError = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ error: ErrorDetails }),
    Schema.Struct({ response: Schema.Struct({ error: ErrorDetails }) }),
  ]),
);
const CodexWindow = Schema.Struct({
  used_percent: Schema.Number,
  reset_at: Schema.optional(Schema.NullOr(Schema.Number)),
});
const CodexWindows = Schema.Struct({
  primary: Schema.optional(Schema.NullOr(CodexWindow)),
  secondary: Schema.optional(Schema.NullOr(CodexWindow)),
});
export type CodexUsageLimitWindows = typeof CodexWindows.Type;
const decodeCodexRateLimits = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("codex.rate_limits"),
    metered_limit_name: Schema.optional(Schema.NullOr(Schema.String)),
    limit_name: Schema.optional(Schema.NullOr(Schema.String)),
    rate_limits: CodexWindows,
  }),
);

function futureReset(resetMs: number, observedAt: string): string | null {
  return Number.isFinite(resetMs) && resetMs > Date.parse(observedAt) && resetMs <= 8.64e15
    ? DateTime.formatIso(DateTime.makeUnsafe(resetMs))
    : null;
}

/** Preserve provider error codes and reset timestamps before Pi formats the error. */
export function usageLimitFromErrorPayload(
  payload: unknown,
  observedAt: string,
): ProviderUsageLimit | null {
  const decoded = decodeStructuredError(payload);
  if (!Number.isFinite(Date.parse(observedAt)) || Option.isNone(decoded)) return null;
  const error = "error" in decoded.value ? decoded.value.error : decoded.value.response.error;
  const code = error.code ?? error.type;
  if (
    code !== "usage_limit_reached" &&
    code !== "rate_limit_exceeded" &&
    code !== "rate_limit_error"
  )
    return null;
  const resetMs =
    error.resets_at !== undefined
      ? error.resets_at * 1000
      : error.resets_in_seconds !== undefined
        ? Date.parse(observedAt) + error.resets_in_seconds * 1000
        : NaN;
  return { resetAt: futureReset(resetMs, observedAt) };
}

/** Codex emits independent quota buckets; a partial update must preserve the others. */
export function codexUsageLimitFromStreamEvent(
  payload: unknown,
  observedAt: string,
  previous?: ReadonlyMap<string, CodexUsageLimitWindows>,
) {
  const decoded = decodeCodexRateLimits(payload);
  if (Option.isNone(decoded)) return null;
  const event = decoded.value;
  const id = event.metered_limit_name ?? event.limit_name ?? "codex";
  const windows = { ...previous?.get(id), ...event.rate_limits };
  return {
    id,
    windows,
    status: piQuotaStatus(
      {
        rate_limit: {
          primary_window: windows.primary,
          secondary_window: windows.secondary,
        },
      },
      observedAt,
    ),
  };
}

/** Any unknown blocking reset keeps recovery unscheduled. */
export function mergeUsageLimits(
  limits: ReadonlyArray<ProviderUsageLimit>,
): ProviderUsageLimit | null {
  let latest: string | null = null;
  for (const limit of limits) {
    if (limit.resetAt === null) return { resetAt: null };
    if (latest === null || limit.resetAt > latest) latest = limit.resetAt;
  }
  return latest === null ? null : { resetAt: latest };
}

/** Read the same quota header families Codex uses for its account snapshots. */
export function codexUsageLimitFromHeaders(headers: Headers, observedAt: string): UsageLimitStatus {
  const readWindow = (prefix: string) => {
    const percent = headers.get(`${prefix}-used-percent`);
    if (percent === null || percent.trim() === "") return undefined;
    const reset = headers.get(`${prefix}-reset-at`);
    const after = headers.get(`${prefix}-reset-after-seconds`);
    return {
      used_percent: Number(percent),
      ...(reset === null || reset.trim() === "" ? {} : { reset_at: Number(reset) }),
      ...(after === null || after.trim() === "" ? {} : { reset_after_seconds: Number(after) }),
    };
  };
  return piQuotaStatus(
    {
      rate_limit: {
        primary_window: readWindow("x-codex-primary"),
        secondary_window: readWindow("x-codex-secondary"),
      },
    },
    observedAt,
  );
}

/** HTTP Retry-After is a request retry delay, not a subscription reset timestamp. */
export function usageLimitFromHttpError(
  headers: Headers,
  body: unknown,
  observedAt: string,
): ProviderUsageLimit | null {
  const fromBody = usageLimitFromErrorPayload(body, observedAt);
  const codex = codexUsageLimitFromHeaders(headers, observedAt);
  const overage = headers.get("anthropic-ratelimit-unified-overage-status");
  if (overage === "allowed" || overage === "allowed_warning") return null;
  const rejected: ProviderUsageLimit[] = [];
  for (const [name, value] of headers) {
    const claim = /^anthropic-ratelimit-unified-(?:(.+)-)?status$/.exec(name);
    if (claim === null || value !== "rejected") continue;
    const prefix = claim[1] === undefined ? "" : `${claim[1]}-`;
    const reset = headers.get(`anthropic-ratelimit-unified-${prefix}reset`);
    rejected.push({ resetAt: futureReset(Number(reset) * 1000, observedAt) });
  }
  if (rejected.length > 0) return mergeUsageLimits(rejected);
  if (codex.type === "limited") {
    return mergeUsageLimits([
      { resetAt: codex.resetAt },
      ...(fromBody?.resetAt == null ? [] : [fromBody]),
    ]);
  }
  return fromBody;
}
