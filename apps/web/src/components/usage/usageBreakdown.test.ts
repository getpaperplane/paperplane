import type { ModelTotals } from "@rove-code/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import {
  cacheHitRate,
  costPerMillionTokens,
  modelShare,
  modelSortValue,
  sortModels,
  sortModelsByTokens,
} from "./usageBreakdown";

const model = (
  name: string,
  totalTokens: number,
  costUsd: number,
  overrides: Partial<ModelTotals> = {},
): ModelTotals => ({
  model: name,
  provider: "codex",
  costUsd,
  totalTokens,
  tokens: {
    uncachedInputTokens: totalTokens,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  },
  uncachedInputTokens: totalTokens,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  records: 1,
  unpricedRecords: 0,
  unpricedTokens: 0,
  costShare: 0,
  tokenShare: 0,
  ...overrides,
});

describe("sortModelsByTokens", () => {
  it("sorts by tokens, breaks ties by cost, and leaves the input alone", () => {
    const models = [
      model("lower-cost", 100, 1),
      model("more-tokens", 200, 2),
      model("higher-cost", 100, 3),
    ];

    expect(sortModelsByTokens(models).map((item) => item.model)).toEqual([
      "more-tokens",
      "higher-cost",
      "lower-cost",
    ]);
    expect(models.map((item) => item.model)).toEqual(["lower-cost", "more-tokens", "higher-cost"]);
  });
});

describe("sortModels", () => {
  it("ranks unpriced models below priced free models and sorts responses independently", () => {
    const models = [
      model("unpriced", 900, 0, { unpricedRecords: 1 }),
      model("free", 10, 0, { records: 3 }),
      model("paid", 10, 5),
    ];
    expect(sortModels(models, "cost").map((item) => item.model)).toEqual([
      "paid",
      "free",
      "unpriced",
    ]);
    expect(sortModels(models, "responses").map((item) => item.model)).toEqual([
      "free",
      "unpriced",
      "paid",
    ]);
  });
});

describe("modelShare", () => {
  it("follows the selected metric", () => {
    const priced = model("priced", 100, 9, { costShare: 0.9, tokenShare: 0.25 });

    expect(modelShare(priced, "cost")).toBe(0.9);
    expect(modelShare(priced, "tokens")).toBe(0.25);
  });

  it("has no cost share for an unknown cost but keeps its token share", () => {
    const unpriced = model("unpriced", 300, 0, {
      unpricedRecords: 1,
      unpricedTokens: 300,
      tokenShare: 0.75,
    });

    expect(modelShare(unpriced, "cost")).toBeNull();
    expect(modelShare(unpriced, "tokens")).toBe(0.75);
  });
});

describe("model rates", () => {
  it("counts cache writes as misses and leaves unpriced tokens out of $/1M", () => {
    const mixed = model("mixed", 4_000_000, 6, {
      tokens: {
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        cacheCreationTokens: 2_000_000,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      records: 4,
      unpricedRecords: 1,
      unpricedTokens: 1_000_000,
    });

    expect(cacheHitRate(mixed)).toBe(0.25);
    expect(costPerMillionTokens(mixed)).toBe(2);
    expect(costPerMillionTokens({ ...mixed, unpricedRecords: 4 })).toBeNull();
  });
});

describe("modelSortValue", () => {
  it("reads the figure each sort key ranks by", () => {
    const m = model("a", 100, 2, {
      records: 7,
      tokens: {
        uncachedInputTokens: 25,
        cachedInputTokens: 75,
        cacheCreationTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
    });
    expect(modelSortValue(m, "cost")).toBe(2);
    expect(modelSortValue(m, "tokens")).toBe(100);
    expect(modelSortValue(m, "responses")).toBe(7);
    expect(modelSortValue(m, "cacheHit")).toBe(0.75);
  });

  it("ranks unknown cost and missing input below zero", () => {
    const m = model("a", 0, 0, {
      records: 1,
      unpricedRecords: 1,
      tokens: {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
    });
    expect(modelSortValue(m, "cost")).toBe(-1);
    expect(modelSortValue(m, "cacheHit")).toBe(-1);
  });
});
