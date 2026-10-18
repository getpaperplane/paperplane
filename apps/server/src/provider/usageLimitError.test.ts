import { describe, expect, it } from "vite-plus/test";
import {
  usageLimitFromError,
  usageLimitFromErrorPayload,
  usageLimitFromHttpError,
} from "./usageLimitError.ts";

const now = "2026-10-01T00:00:00.000Z";

describe("usageLimitFromError", () => {
  it("recognizes Pi SDK ChatGPT limits with a conservative rounding margin", () => {
    expect(
      usageLimitFromError(
        "You have hit your ChatGPT usage limit (plus plan). Try again in ~123 min.",
        now,
      ),
    ).toEqual({ resetAt: "2026-10-01T02:04:00.000Z" });
  });
  it("reads subscription CLI limits generically, including epoch resets", () => {
    for (const window of ["session", "weekly", "Opus", "weekly Opus"]) {
      expect(
        usageLimitFromError(
          `You've hit your ${window} limit · resets 11:10am (Australia/Sydney)`,
          now,
        ),
      ).toEqual({ resetAt: "2026-10-01T01:10:00.000Z" });
    }
    expect(
      usageLimitFromError(`Claude AI usage limit reached|${Date.parse(now) / 1000 + 3600}`, now),
    ).toEqual({ resetAt: "2026-10-01T01:00:00.000Z" });
    expect(usageLimitFromError("You've hit your weekly limit · resets in 2h 30m", now)).toEqual({
      resetAt: "2026-10-01T02:30:00.000Z",
    });
  });
  it("resolves dated resets and rolls past local times to their next occurrence", () => {
    expect(
      usageLimitFromError("You've hit your session limit · resets 9am (Australia/Sydney)", now),
    ).toEqual({ resetAt: "2026-10-01T23:00:00.000Z" });
    for (const reset of ["Oct 5, 3pm", "3pm on Oct 5", "Oct 5, 2026, 3pm"]) {
      expect(
        usageLimitFromError(
          `You've hit your weekly limit · resets ${reset} (Australia/Sydney)`,
          now,
        ),
      ).toEqual({ resetAt: "2026-10-05T04:00:00.000Z" });
    }
    expect(
      usageLimitFromError(
        "You've hit your weekly limit · resets Jan 1, 3pm (UTC)",
        "2026-12-30T00:00:00.000Z",
      ),
    ).toEqual({ resetAt: "2027-01-01T15:00:00.000Z" });
  });
  it("rejects resets beyond the weekly horizon, such as a yearless date rolled to next year", () => {
    expect(
      usageLimitFromError("You've hit your weekly limit · resets Jan 1, 3pm (UTC)", now),
    ).toEqual({ resetAt: null });
    expect(usageLimitFromError("Usage limit reached | 1900000000", now)).toEqual({
      resetAt: null,
    });
  });
  it("does not roll a time-only reset to tomorrow when it passed under an hour ago", () => {
    // 11:10am Sydney (UTC+10 in early October) is 01:10Z.
    expect(
      usageLimitFromError(
        "You've hit your session limit · resets 11:10am (Australia/Sydney)",
        "2026-10-01T01:30:00.000Z",
      ),
    ).toEqual({ resetAt: null });
    expect(
      usageLimitFromError(
        "You've hit your session limit · resets 11:10am (Australia/Sydney)",
        "2026-10-01T02:30:00.000Z",
      ),
    ).toEqual({ resetAt: "2026-10-02T01:10:00.000Z" });
  });
  it("ignores context-window and token limits", () => {
    for (const message of [
      "You've hit your context window limit",
      "You've hit your token limit for this request",
      "You've hit your max context length limit",
      "You've hit your message size limit",
    ])
      expect(usageLimitFromError(message, now)).toBeNull();
  });
  it("accepts other Claude subscription wordings", () => {
    for (const message of [
      "5-hour limit reached ∙ resets 11:10am (Australia/Sydney)",
      "Weekly limit reached ∙ resets 11:10am (Australia/Sydney)",
      "Your limit will reset at 11:10am (Australia/Sydney)",
    ])
      expect(usageLimitFromError(message, now)).toEqual({ resetAt: "2026-10-01T01:10:00.000Z" });
  });
  it("uses the reset day's DST offset and selects a future repeated hour", () => {
    expect(
      usageLimitFromError(
        "You've hit your session limit · resets 9am (America/New_York)",
        "2026-03-07T15:00:00.000Z",
      ),
    ).toEqual({ resetAt: "2026-03-08T13:00:00.000Z" });
    expect(
      usageLimitFromError(
        "You've hit your session limit · resets 1:30am (America/New_York)",
        "2026-11-01T05:45:00.000Z",
      ),
    ).toEqual({ resetAt: "2026-11-01T06:30:00.000Z" });
  });
  it("keeps unknown CLI resets classified without inventing timestamps", () => {
    for (const reset of [
      "",
      " · resets soon",
      " · resets 3pm (Unknown/Zone)",
      " · resets Feb 30, 3pm (UTC)",
      " · resets 25:00 (UTC)",
      " · resets Oct 20, 2025, 3pm (UTC)",
      " · resets Oct 20, 3pm (UTC)",
    ]) {
      expect(usageLimitFromError(`You've hit your Opus limit${reset}`, now)).toEqual({
        resetAt: null,
      });
    }
    expect(
      usageLimitFromError("You've hit your session limit. Authentication required", now),
    ).toBeNull();
  });
  it("supports weekly and short windows without a fixed duration", () => {
    expect(
      usageLimitFromError("Codex usage limit reached. The weekly limit resets in 5d 5h.", now)
        ?.resetAt,
    ).toBe("2026-10-06T05:00:00.000Z");
    expect(usageLimitFromError("Rate limit reached. Try again in 30 seconds.", now)?.resetAt).toBe(
      "2026-10-01T00:00:30.000Z",
    );
  });
  it("preserves explicit upstream timestamps and relative reset seconds", () => {
    expect(
      usageLimitFromError(
        JSON.stringify({
          error: { type: "usage_limit_reached", resets_at: Date.parse(now) / 1000 + 7200 },
        }),
        now,
      )?.resetAt,
    ).toBe("2026-10-01T02:00:00.000Z");
    expect(
      usageLimitFromError(
        JSON.stringify({ error: { code: "rate_limit_exceeded", resets_in_seconds: 90 } }),
        now,
      )?.resetAt,
    ).toBe("2026-10-01T00:01:30.000Z");
  });
  it("reads Codex WebSocket limit events and ignores other stream events", () => {
    expect(
      usageLimitFromErrorPayload(
        {
          type: "error",
          status: 429,
          error: {
            type: "usage_limit_reached",
            message: "The usage limit has been reached",
            resets_at: Date.parse(now) / 1000 + 3600,
          },
        },
        now,
      ),
    ).toEqual({ resetAt: "2026-10-01T01:00:00.000Z" });
    expect(usageLimitFromErrorPayload({ type: "response.created" }, now)).toBeNull();
    expect(
      usageLimitFromErrorPayload({ type: "error", error: { type: "server_error" } }, now),
    ).toBeNull();
  });
  it("reads HTTP 429 limits from Codex bodies and Anthropic rejected windows", () => {
    const at = Date.parse(now) / 1000;
    expect(
      usageLimitFromHttpError(
        new Headers(),
        { error: { type: "usage_limit_reached", resets_at: at + 600 } },
        now,
      ),
    ).toEqual({ resetAt: "2026-10-01T00:10:00.000Z" });
    const anthropicBody = { type: "error", error: { type: "rate_limit_error", message: "Error" } };
    expect(
      usageLimitFromHttpError(
        new Headers({
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-reset": String(at + 3600),
          "anthropic-ratelimit-unified-5h-status": "allowed",
          "anthropic-ratelimit-unified-5h-reset": String(at + 4 * 86400),
          "anthropic-ratelimit-unified-7d_oi-status": "rejected",
          "anthropic-ratelimit-unified-7d_oi-reset": String(at + 86400),
        }),
        anthropicBody,
        now,
      ),
    ).toEqual({ resetAt: "2026-10-02T00:00:00.000Z" });
    expect(usageLimitFromHttpError(new Headers({ "retry-after": "30" }), anthropicBody, now)).toBe(
      null,
    );
    expect(
      usageLimitFromHttpError(
        new Headers({ "anthropic-ratelimit-unified-status": "rejected" }),
        anthropicBody,
        now,
      ),
    ).toEqual({ resetAt: null });
  });
  it("does not invent times for missing, expired, malformed, or zero windows", () => {
    for (const error of [
      "Usage limit reached.",
      "Codex error: The usage limit has been reached",
      "Usage limit reached. Try again in ~0 min.",
      JSON.stringify({ error: { code: "usage_limit_reached", resets_at: 1 } }),
    ]) {
      expect(usageLimitFromError(error, now)).toEqual({ resetAt: null });
    }
    expect(usageLimitFromError("Usage limit reached.", "invalid")).toBeNull();
  });
  it("does not schedule authentication, billing, or unrelated errors", () => {
    for (const error of [
      "429 overloaded",
      "Request failed",
      "Usage limit reached. Payment required",
      "insufficient_quota",
      JSON.stringify({ error: { code: "usage_not_included" } }),
    ]) {
      expect(usageLimitFromError(error, now)).toBeNull();
    }
  });
});
