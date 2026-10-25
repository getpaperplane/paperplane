import { describe, expect, it } from "vite-plus/test";
import {
  codexUsageLimitFromStreamEvent,
  codexUsageLimitFromHeaders,
  usageLimitFromErrorPayload,
  usageLimitFromHttpError,
} from "./usageLimitError.ts";

const now = "2026-10-01T00:00:00.000Z";
const at = Date.parse(now) / 1000;
const anthropicBody = { type: "error", error: { type: "rate_limit_error", message: "Error" } };

describe("structured provider usage limits", () => {
  it("reads native error envelopes without depending on message wording", () => {
    for (const envelope of [
      { error: { type: "usage_limit_reached", resets_at: at + 3600 } },
      {
        type: "response.failed",
        response: { error: { code: "rate_limit_exceeded", resets_in_seconds: 3600 } },
      },
    ]) {
      expect(usageLimitFromErrorPayload(envelope, now)).toEqual({
        resetAt: "2026-10-01T01:00:00.000Z",
      });
    }
    expect(usageLimitFromErrorPayload(anthropicBody, now)).toEqual({ resetAt: null });
    for (const code of [
      "insufficient_quota",
      "usage_not_included",
      "server_error",
      "authentication_error",
    ]) {
      expect(
        usageLimitFromErrorPayload(
          { error: { code, resets_at: at + 3600, message: "Usage limit reached" } },
          now,
        ),
      ).toBeNull();
    }
  });

  it("reads Codex quota events, including nondefault buckets and missing resets", () => {
    expect(
      codexUsageLimitFromStreamEvent(
        {
          type: "codex.rate_limits",
          metered_limit_name: "codex_model",
          rate_limits: {
            primary: { used_percent: 100, reset_at: at + 3600 },
            secondary: { used_percent: 100, reset_at: at + 86400 },
          },
        },
        now,
      )?.status,
    ).toEqual({ type: "limited", resetAt: "2026-10-02T00:00:00.000Z" });
    expect(
      codexUsageLimitFromStreamEvent(
        {
          type: "codex.rate_limits",
          rate_limits: {
            primary: { used_percent: 100, reset_at: at + 3600 },
            secondary: { used_percent: 100 },
          },
        },
        now,
      )?.status,
    ).toEqual({ type: "limited", resetAt: null });
  });

  it("reads Codex HTTP quota headers when the error body omits the reset", () => {
    const headers = new Headers({
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(at + 3600),
      "x-codex-secondary-used-percent": "10",
    });
    expect(
      usageLimitFromHttpError(headers, { error: { type: "usage_limit_reached" } }, now),
    ).toEqual({ resetAt: "2026-10-01T01:00:00.000Z" });
    expect(codexUsageLimitFromHeaders(new Headers(), now)).toEqual({ type: "unavailable" });
  });

  it("waits for all rejected Anthropic windows and leaves incomplete evidence unscheduled", () => {
    const headers = new Headers({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": String(at + 3600),
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-5h-reset": String(at + 4 * 86400),
      "anthropic-ratelimit-unified-7d_oi-status": "rejected",
      "anthropic-ratelimit-unified-7d_oi-reset": String(at + 86400),
    });
    expect(usageLimitFromHttpError(headers, anthropicBody, now)).toEqual({
      resetAt: "2026-10-02T00:00:00.000Z",
    });
    headers.delete("anthropic-ratelimit-unified-7d_oi-reset");
    expect(usageLimitFromHttpError(headers, anthropicBody, now)).toEqual({ resetAt: null });
    expect(
      usageLimitFromHttpError(new Headers({ "retry-after": "30" }), anthropicBody, now),
    ).toEqual({ resetAt: null });
  });

  it("does not block on a rejected subscription window when overage is allowed", () => {
    const headers = new Headers({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": String(at + 3600),
    });
    expect(usageLimitFromHttpError(headers, anthropicBody, now)).toEqual({
      resetAt: "2026-10-01T01:00:00.000Z",
    });
    headers.set("anthropic-ratelimit-unified-overage-status", "allowed");
    expect(usageLimitFromHttpError(headers, anthropicBody, now)).toBeNull();
  });

  it("preserves explicit monthly resets and rejects invalid or expired timestamps", () => {
    expect(
      usageLimitFromErrorPayload(
        { error: { type: "usage_limit_reached", resets_at: at + 30 * 86400 } },
        now,
      ),
    ).toEqual({ resetAt: "2026-10-31T00:00:00.000Z" });
    for (const reset of [0, at - 1, Infinity, 8.64e15]) {
      expect(
        usageLimitFromErrorPayload(
          { error: { type: "usage_limit_reached", resets_at: reset } },
          now,
        ),
      ).toEqual({ resetAt: null });
    }
  });
});
