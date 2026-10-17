import type { UsageTokenTotals } from "@rove-code/contracts";
import {
  isModelCostUnknown,
  type CategoryCost,
  type ModelTotals,
  type SpeedCost,
} from "@rove-code/shared/usageMerge";

import type { ShareSegment } from "./UsageShareBar";

export type ModelSortKey = "cost" | "tokens" | "responses" | "cacheHit";

/** Options for the model breakdown sort, in menu order. */
export const MODEL_SORT_OPTIONS = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
  { value: "responses", label: "Responses" },
  { value: "cacheHit", label: "Cache hit" },
] as const satisfies readonly { value: ModelSortKey; label: string }[];

/** A model's figure for the sort key; unknown cost and no input rank below zero. */
export function modelSortValue(model: ModelTotals, key: ModelSortKey): number {
  switch (key) {
    case "cost":
      return isModelCostUnknown(model) ? -1 : model.costUsd;
    case "tokens":
      return model.totalTokens;
    case "responses":
      return model.records;
    case "cacheHit":
      return cacheHitRate(model) ?? -1;
  }
}

/** Descending by the selected column, with stable token/cost tie breakers. */
export function sortModels(models: readonly ModelTotals[], key: ModelSortKey) {
  return models.toSorted(
    (left, right) =>
      modelSortValue(right, key) - modelSortValue(left, key) ||
      right.totalTokens - left.totalTokens ||
      right.costUsd - left.costUsd,
  );
}

export function sortModelsByTokens(models: readonly ModelTotals[]) {
  return models.toSorted(
    (left, right) => right.totalTokens - left.totalTokens || right.costUsd - left.costUsd,
  );
}

/**
 * A model's share of the selected metric, or `null` for a cost share of an
 * unknown cost. An unpriced model still has a real token share.
 */
export function modelShare(model: ModelTotals, metric: "cost" | "tokens"): number | null {
  if (metric === "tokens") return model.tokenShare;
  return isModelCostUnknown(model) ? null : model.costShare;
}

/**
 * Share of a model's input read from cache, or `null` without input. Cache
 * writes count as misses: that input was processed in full.
 */
export function cacheHitRate(
  totals:
    | ModelTotals
    | Pick<UsageTokenTotals, "cachedInputTokens" | "cacheCreationTokens" | "uncachedInputTokens">,
): number | null {
  const tokens = "tokens" in totals ? totals.tokens : totals;
  const input = tokens.uncachedInputTokens + tokens.cachedInputTokens + tokens.cacheCreationTokens;
  return input === 0 ? null : tokens.cachedInputTokens / input;
}

/** Effective USD per million priced tokens, or `null` when none were priced. */
export function costPerMillionTokens(model: ModelTotals): number | null {
  const pricedTokens = model.totalTokens - model.unpricedTokens;
  return pricedTokens <= 0 || isModelCostUnknown(model)
    ? null
    : (model.costUsd / pricedTokens) * 1_000_000;
}

/** A neutral step between background and foreground, so mixes never borrow a provider's color. */
const ink = (percent: number) =>
  `color-mix(in oklab, var(--foreground) ${percent}%, var(--background))`;

/** Adjacent segments stay above the 15 ΔE separation floor in both themes. */
const TYPE_COLORS = {
  input: ink(60),
  cacheRead: ink(30),
  cacheWrite: ink(72),
  output: ink(100),
  other: ink(44),
};

export function costTypeSegments(cost: CategoryCost): readonly ShareSegment[] {
  return [
    { label: "Input", value: cost.input, color: TYPE_COLORS.input },
    { label: "Cache read", value: cost.cacheRead, color: TYPE_COLORS.cacheRead },
    { label: "Cache write", value: cost.cacheWrite, color: TYPE_COLORS.cacheWrite },
    { label: "Output", value: cost.output, color: TYPE_COLORS.output },
    // Reported cost with no rates to split it, or from older servers. Below a
    // cent it is rounding, not usage.
    { label: "Other", value: cost.unsplit >= 0.005 ? cost.unsplit : 0, color: TYPE_COLORS.other },
  ];
}

export function tokenTypeSegments(
  tokens: Omit<UsageTokenTotals, "reasoningTokens">,
): readonly ShareSegment[] {
  return [
    { label: "Input", value: tokens.uncachedInputTokens, color: TYPE_COLORS.input },
    { label: "Cache read", value: tokens.cachedInputTokens, color: TYPE_COLORS.cacheRead },
    { label: "Cache write", value: tokens.cacheCreationTokens, color: TYPE_COLORS.cacheWrite },
    { label: "Output", value: tokens.outputTokens, color: TYPE_COLORS.output },
  ];
}

/** Speeds are ordered by price, so they brighten from standard to ultrafast. */
export function speedCostSegments(cost: SpeedCost): readonly ShareSegment[] {
  return [
    { label: "Standard", value: cost.standard, color: ink(34) },
    { label: "Fast", value: cost.fast, color: ink(66) },
    { label: "Ultrafast", value: cost.ultrafast, color: ink(100) },
  ];
}
