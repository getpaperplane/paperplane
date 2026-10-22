import { describe, expect, it } from "@effect/vitest";
import { piUsageFormat } from "./usage.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const usage = {
  input: 100,
  output: 20,
  cacheRead: 30,
  cacheWrite: 40,
  reasoning: 5,
  cost: { total: 0.25 },
};
const assistant = {
  type: "message",
  id: "a1",
  timestamp,
  message: {
    role: "assistant",
    provider: "fixture",
    model: "model",
    responseModel: "billed-model",
    usage,
  },
};

describe("retained Pi SDK usage format", () => {
  it("reads native session records and disjoint tokens with the billed model and provider cost", () => {
    const state = piUsageFormat.state.initial();
    expect(piUsageFormat.parseLine('{"type":"session","id":"session"}', state)).toEqual([]);
    const [record] = piUsageFormat.parseLine(JSON.stringify(assistant), state);
    expect(record).toMatchObject({
      sessionId: "session",
      provider: "pi",
      model: "fixture/billed-model",
      rateModel: "billed-model",
      totals: {
        uncachedInputTokens: 100,
        cachedInputTokens: 30,
        cacheCreationTokens: 40,
        outputTokens: 20,
        reasoningTokens: 5,
      },
      reportedCostUsd: 0.25,
    });
    expect(piUsageFormat.parseProjected(assistant, state)).toEqual([record]);
  });

  it.each(["compaction", "branch_summary", "toolResult", "usage"])(
    "retains auxiliary %s work",
    (type) => {
      const entry =
        type === "toolResult"
          ? { type: "message", id: "extra", timestamp, message: { role: type, usage } }
          : type === "usage"
            ? { type, id: "extra", timestamp, usage, provider: "other", model: "warm" }
            : { type, id: "extra", timestamp, usage };
      const [record] = piUsageFormat.parseProjected(entry, piUsageFormat.state.initial());
      expect(record?.model).toBe(type === "usage" ? "other/warm" : "Tools/summaries");
      expect(record?.reportedCostUsd).toBe(0.25);
    },
  );

  it("deduplicates copied fork entries without dropping distinct equal requests", () => {
    const original = piUsageFormat.state.initial();
    const fork = piUsageFormat.state.initial();
    piUsageFormat.parseProjected({ type: "session", id: "original" }, original);
    piUsageFormat.parseProjected({ type: "session", id: "fork" }, fork);
    const [a] = piUsageFormat.parseProjected(assistant, original);
    const [b] = piUsageFormat.parseProjected(assistant, fork);
    const [c] = piUsageFormat.parseProjected({ ...assistant, id: "a2" }, fork);
    expect(a?.sessionId).not.toBe(b?.sessionId);
    expect(a?.dedupeKey).toBe(b?.dedupeKey);
    expect(a?.dedupeKey).not.toBe(c?.dedupeKey);
  });

  it("leaves zero SDK prices for shared pricing and rejects malformed or empty records", () => {
    const state = piUsageFormat.state.initial();
    const [free] = piUsageFormat.parseProjected(
      { ...assistant, message: { ...assistant.message, usage: { input: 1, cost: { total: 0 } } } },
      state,
    );
    expect(free?.reportedCostUsd).toBeNull();
    expect(piUsageFormat.parseLine("not-json", state)).toEqual([]);
    expect(piUsageFormat.parseProjected({ ...assistant, timestamp: "invalid" }, state)).toEqual([]);
    expect(
      piUsageFormat.parseProjected(
        { ...assistant, message: { ...assistant.message, usage: { input: -1 } } },
        state,
      ),
    ).toEqual([]);
  });
});
