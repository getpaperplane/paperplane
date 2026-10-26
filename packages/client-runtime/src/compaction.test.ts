import { describe, expect, it } from "vite-plus/test";
import { hasContextPressure, promptCacheCompactionDueAt } from "./compaction.ts";

describe("compaction offers", () => {
  it("warns against the model-specific threshold, not total processed tokens", () => {
    expect(
      hasContextPressure({ usedTokens: 100000, maxTokens: 128000, autoCompactThreshold: 110000 }),
    ).toBe(true);
    expect(
      hasContextPressure({ usedTokens: 100000, maxTokens: 1000000, autoCompactThreshold: 600000 }),
    ).toBe(false);
    expect(hasContextPressure({ usedTokens: null, maxTokens: 128000 })).toBe(false);
    expect(hasContextPressure({ usedTokens: 300000 })).toBe(false);
  });
  it("uses persisted Pi expiry without resetting it when thread metadata changes", () => {
    expect(
      promptCacheCompactionDueAt({
        provider: "pi",
        usedTokens: 80000,
        maxTokens: 128000,
        updatedAt: "2026-10-26T12:30:00Z",
        promptCacheExpiresAt: "2026-10-26T12:05:00Z",
      }),
    ).toBe(Date.parse("2026-10-26T12:05:00Z"));
  });
  it("never borrows Claude's fallback for an unknown Pi cache lifetime", () => {
    expect(
      promptCacheCompactionDueAt({
        provider: "pi",
        usedTokens: 200000,
        updatedAt: "2026-10-26T12:00:00Z",
      }),
    ).toBeNull();
    expect(
      promptCacheCompactionDueAt({
        provider: "pi",
        usedTokens: null,
        promptCacheExpiresAt: "2026-10-26T12:05:00Z",
      }),
    ).toBeNull();
  });
  it("does not recommend cache compaction for small conversations", () => {
    expect(
      promptCacheCompactionDueAt({
        provider: "pi",
        usedTokens: 1000,
        maxTokens: 128000,
        promptCacheExpiresAt: "2026-10-26T12:05:00Z",
      }),
    ).toBeNull();
  });
});
