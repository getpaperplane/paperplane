// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { initialPiScanState, parsePiModelRates, parsePiRecord } from "./piUsage.ts";
import { UsageAggregator } from "./usageAggregation.ts";
import {
  cacheSavingsUsd,
  createOverrideRateTable,
  parseRateTable,
  priceUsage,
} from "./usagePricing.ts";
import { decodeScanCache, encodeScanCache, type ScanCache } from "./usageScanCache.ts";
import { readTranscriptRecords } from "./usageTranscriptReader.ts";
import type { PiAgentEntry } from "../provider/Layers/PiSubagents.ts";

const timestamp = "2026-08-01T10:00:00Z";
const usage = {
  input: 100,
  output: 40,
  cacheRead: 200,
  cacheWrite: 30,
  reasoning: 10,
  totalTokens: 370,
  cost: { input: 0.0002, output: 0.0004, cacheRead: 0.00002, cacheWrite: 0.00006, total: 0.00068 },
};
function assistant(id = "message-a", model = "model-a", provider = "custom") {
  return {
    type: "message",
    id,
    timestamp,
    message: { role: "assistant", provider, model, usage },
  };
}
const modelCost = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2 };

function subagentEntry(
  k: string,
  q: number,
  fields: Partial<PiAgentEntry> & { src?: string } = {},
) {
  return { v: 1, k, a: "child-a", th: "thread-a", w: 123, q, at: Date.parse(timestamp), ...fields };
}

function subagentUsage(q = 3) {
  return subagentEntry("usage", q, { in: 100, outTok: 40, cr: 200, cw: 30, cost: 1.25 });
}

function aggregator() {
  return new UsageAggregator({
    timeZone: "UTC",
    sinceDay: "2026-08-01",
    untilDay: "2026-08-01",
    rates: new Map(),
  });
}

describe("Pi usage", () => {
  it("counts owned subagents once, carrying their effective model and saved prices", () => {
    const state = initialPiScanState();
    parsePiRecord(subagentEntry("start", 0, { cwd: "/project" }), state);
    parsePiRecord(subagentEntry("meta", 1, { model: "custom/model-a" }), state);
    const first = parsePiRecord(subagentUsage(), state)!;
    expect(first.sessionId).toBe("pi-subagent:thread-a:child-a");
    expect(first.totals).toEqual({
      uncachedInputTokens: 100,
      cachedInputTokens: 200,
      cacheCreationTokens: 30,
      outputTokens: 40,
      reasoningTokens: 0,
    });
    expect(first.model).toBe("custom/model-a");
    expect(first.rateModel).toBe("model-a");
    expect(priceUsage(new Map(), first)).toEqual({ costUsd: 1.25, costSource: "providerReported" });
    parsePiRecord(subagentEntry("text", 4, { model: "other/model-b" }), state);
    const next = parsePiRecord(subagentUsage(5), state)!;
    expect(next.model).toBe("other/model-b");
    expect(next.rateModel).toBe("model-b");
    const result = aggregator();
    expect(result.add(first)).toBe(true);
    expect(result.add(first)).toBe(false);
    expect(result.add(next)).toBe(true);
    const differentWriter = parsePiRecord({ ...subagentUsage(5), w: 456 }, state)!;
    expect(result.add(differentWriter)).toBe(true);
    expect(result.finish().buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0)).toBe(3.75);
  });

  it("rejects malformed, cumulative, and legacy observed subagent usage", () => {
    const state = initialPiScanState();
    expect(parsePiRecord(subagentUsage(), state)).toBeNull();
    for (const fields of [{ src: "pi" }, { src: "agent" }, { cmd: "pi --mode json" }]) {
      parsePiRecord(subagentEntry("start", 0, fields), state);
      parsePiRecord(subagentEntry("meta", 1, { model: "custom/model-a" }), state);
      expect(parsePiRecord(subagentUsage(), state)).toBeNull();
    }
    parsePiRecord(subagentEntry("start", 0), state);
    expect(parsePiRecord(subagentUsage(), state)).toBeNull();
    parsePiRecord(subagentEntry("meta", 1, { model: "custom/model-a" }), state);
    for (const fields of [{ in: -1 }, { at: NaN }, { v: 2 }, { cum: true }]) {
      expect(parsePiRecord({ ...subagentUsage(), ...fields }, state)).toBeNull();
    }
    expect(parsePiRecord(subagentEntry("tool", 2), state)).toBeNull();
    const costOnly = parsePiRecord(subagentEntry("usage", 4, { cost: 0.25 }), state)!;
    expect(costOnly.reportedCostUsd).toBe(0.25);
    const unpriced = parsePiRecord({ ...subagentUsage(), cost: 0 }, state)!;
    expect(priceUsage(new Map(), unpriced).costSource).toBe("unpriced");
    parsePiRecord(subagentEntry("meta", 5, { session: "/native/session.jsonl" }), state);
    expect(parsePiRecord(subagentUsage(6), state)).toBeNull();
  });

  it("keeps disjoint token counts and saved prices", () => {
    const state = initialPiScanState();
    parsePiRecord({ type: "session", id: "session-a" }, state);
    const record = parsePiRecord(assistant(), state)!;
    expect(record.sessionId).toBe("session-a");
    expect(record.model).toBe("custom/model-a");
    expect(record.totals).toEqual({
      uncachedInputTokens: 100,
      cachedInputTokens: 200,
      cacheCreationTokens: 30,
      outputTokens: 40,
      reasoningTokens: 10,
    });
    const newerRates = parsePiModelRates({
      providers: { custom: { models: [{ id: "model-a", cost: { ...modelCost, input: 99 } }] } },
    });
    expect(priceUsage(newerRates, record)).toEqual({
      costUsd: 0.00068,
      costSource: "providerReported",
    });
    expect(cacheSavingsUsd(newerRates, record)).toBeCloseTo(0.00038);
    const overrides = createOverrideRateTable({
      "custom/model-a": {
        inputCostPerMillionTokens: 1,
        outputCostPerMillionTokens: 1,
        cacheReadCostPerMillionTokens: 1,
        cacheWriteCostPerMillionTokens: 1,
      },
    });
    expect(priceUsage(newerRates, record, overrides).costUsd).toBeCloseTo(0.00037);
    expect(cacheSavingsUsd(newerRates, record, overrides)).toBe(0);
  });

  it("counts compaction, branch summaries, and standalone usage without changing the active model", () => {
    const state = initialPiScanState();
    parsePiRecord({ type: "model_change", provider: "custom", modelId: "model-a" }, state);
    const compact = parsePiRecord({ type: "compaction", id: "compact", timestamp, usage }, state)!;
    const warming = parsePiRecord(
      {
        type: "usage",
        kind: "future-kind",
        id: "warm",
        timestamp,
        provider: "other",
        model: "warm-model",
        usage,
      },
      state,
    )!;
    const branch = parsePiRecord(
      { type: "branch_summary", id: "branch", timestamp, usage },
      state,
    )!;
    expect(compact.model).toBe("custom/model-a");
    expect(warming.model).toBe("other/warm-model");
    expect(branch.model).toBe("custom/model-a");
    parsePiRecord(assistant("switched", "model-b"), state);
    expect(
      parsePiRecord({ type: "compaction", id: "compact-b", timestamp, usage }, state)?.model,
    ).toBe("custom/model-b");
    const result = aggregator();
    for (const record of [compact, warming, branch]) result.add(record);
    expect(result.finish().buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0)).toBeCloseTo(
      usage.cost.total * 3,
    );
  });

  it("does not attribute aggregated tool usage to the main model", () => {
    const state = initialPiScanState();
    parsePiRecord(assistant(), state);
    const record = parsePiRecord(
      { type: "message", id: "tool", timestamp, message: { role: "toolResult", usage } },
      state,
    )!;
    expect(record.model).toBe("tool-usage");
    expect(record.rateModel).toBeUndefined();
    expect(record.reportedCostUsd).toBe(usage.cost.total);
    expect(state.model).toBe("custom/model-a");
  });

  it("drops copied fork entries without dropping distinct equal requests", () => {
    const original = initialPiScanState();
    const fork = initialPiScanState();
    parsePiRecord({ type: "session", id: "original" }, original);
    parsePiRecord({ type: "session", id: "fork" }, fork);
    const result = aggregator();
    expect(result.add(parsePiRecord(assistant(), original)!)).toBe(true);
    expect(result.add(parsePiRecord(assistant(), fork)!)).toBe(false);
    expect(result.add(parsePiRecord(assistant("different-id"), fork)!)).toBe(true);
    expect(result.finish().duplicatesDropped).toBe(1);
    expect(result.finish().buckets[0]?.records).toBe(2);
    expect(result.finish().buckets[0]?.sessions).toBe(2);
  });

  it("uses explicit model prices for zero-cost records and leaves unknown rates unpriced", () => {
    const state = initialPiScanState();
    const entry = assistant();
    const record = parsePiRecord(
      { ...entry, message: { ...entry.message, usage: { ...usage, cost: { total: 0 } } } },
      state,
    )!;
    expect(priceUsage(new Map(), record).costSource).toBe("unpriced");
    const rates = parsePiModelRates({
      providers: { custom: { models: [{ id: "model-a", cost: modelCost }] } },
    });
    expect(priceUsage(rates, record)).toEqual({ costUsd: 0.00068, costSource: "modelPriced" });
    const freeRates = parsePiModelRates({
      providers: {
        custom: {
          models: [{ id: "model-a", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        },
      },
    });
    expect(priceUsage(freeRates, record)).toEqual({ costUsd: 0, costSource: "modelPriced" });
    expect(
      priceUsage(
        parseRateTable({
          "model-a": { input_cost_per_token: 0.000002, output_cost_per_token: 0.00001 },
        }),
        record,
      ).costSource,
    ).toBe("modelPriced");
  });

  it("retains cost-only work and rejects malformed usage", () => {
    const entry = assistant();
    const costOnly = parsePiRecord(
      { ...entry, message: { ...entry.message, usage: { cost: { total: 0.25 } } } },
      initialPiScanState(),
    )!;
    expect(costOnly.reportedCostUsd).toBe(0.25);
    expect(parsePiRecord({ ...entry, timestamp: "invalid" }, initialPiScanState())).toBeNull();
    expect(
      parsePiRecord(
        { ...entry, message: { ...entry.message, usage: { input: -1 } } },
        initialPiScanState(),
      ),
    ).toBeNull();
    expect(
      parsePiRecord(
        { ...entry, message: { ...entry.message, role: "user" } },
        initialPiScanState(),
      ),
    ).toBeNull();
    expect(parsePiRecord({ type: "custom", timestamp, usage }, initialPiScanState())).toBeNull();
    expect(parsePiRecord(null, initialPiScanState())).toBeNull();
  });

  it("keeps model prices provider-qualified and merges partial model overrides", () => {
    const rates = parsePiModelRates({
      providers: {
        first: {
          models: [{ id: "same", cost: modelCost }],
          modelOverrides: { same: { cost: { input: 7 } } },
        },
        second: {
          models: [
            { id: "same", cost: { ...modelCost, input: 3 } },
            { id: "bad", cost: { ...modelCost, input: -1 } },
          ],
        },
      },
    });
    expect(rates.get("first/same")?.inputCostPerToken).toBe(0.000007);
    expect(rates.get("first/same")?.outputCostPerToken).toBe(0.00001);
    expect(rates.get("second/same")?.inputCostPerToken).toBe(0.000003);
    expect(rates.has("second/bad")).toBe(false);
    expect(rates.has("same")).toBe(false);
    expect(parsePiModelRates(null).size).toBe(0);
  });

  it("uses public prices to fill partial built-in overrides and ignores unknown override IDs", () => {
    const publicRates = parseRateTable({
      known: {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.00001,
        cache_read_input_token_cost: 0.0000001,
      },
    });
    const rates = parsePiModelRates(
      {
        providers: {
          custom: {
            modelOverrides: {
              known: { cost: { input: 7 } },
              unknown: { cost: modelCost },
            },
          },
        },
      },
      publicRates,
    );
    expect(rates.get("custom/known")?.inputCostPerToken).toBe(0.000007);
    expect(rates.get("custom/known")?.outputCostPerToken).toBe(0.00001);
    expect(rates.get("custom/known")?.cacheReadCostPerToken).toBe(0.0000001);
    expect(rates.has("custom/unknown")).toBe(false);
  });
});

let dir: string;
beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-usage-test-"));
});
afterEach(async () => {
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

describe("Pi transcript scanning", () => {
  for (const streamingThresholdBytes of [64, 8 * 1024 * 1024]) {
    it(`resumes owned subagent usage after a durable scan (threshold ${streamingThresholdBytes})`, async () => {
      const path = NodePath.join(dir, "child.jsonl");
      const entries = [
        subagentEntry("start", 0),
        subagentEntry("task", 1, { text: "ignored context".repeat(1000) }),
        subagentEntry("meta", 2, { model: "custom/model-a" }),
        subagentUsage(),
        subagentEntry("text", 4, { model: "other/model-b", text: "report".repeat(1000) }),
      ];
      const unfinished = JSON.stringify(subagentUsage(5));
      await NodeFSP.writeFile(
        path,
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n" + unfinished,
      );
      const options = { streamingThresholdBytes };
      const first = (await readTranscriptRecords(path, "pi", undefined, options))!;
      expect(first.records).toHaveLength(1);
      expect(first.records[0]?.model).toBe("custom/model-a");
      expect(first.tailRecords[0]?.model).toBe("other/model-b");
      const cache: ScanCache = new Map([
        [path, { size: (await NodeFSP.stat(path)).size, mtimeMs: 1, provider: "pi", ...first }],
      ]);
      const restored = decodeScanCache(JSON.parse(JSON.stringify(encodeScanCache(cache)))).get(
        path,
      )!;
      expect(restored.position.piState?.subagent).toBe(true);
      await NodeFSP.appendFile(path, "\n" + JSON.stringify(subagentUsage(6)) + "\n");
      const appended = (await readTranscriptRecords(path, "pi", restored.position, options))!;
      expect(appended.resumed).toBe(true);
      expect(appended.records).toHaveLength(2);
      expect(appended.records[0]?.model).toBe("other/model-b");
      expect(appended.records[0]?.sessionId).toBe(first.records[0]?.sessionId);
      const full = await readTranscriptRecords(path, "pi", undefined, options);
      expect([...restored.records, ...appended.records]).toEqual(full?.records);
    });
  }

  it("preserves prices, model state, and unfinished tails through a durable incremental scan", async () => {
    const path = NodePath.join(dir, "session.jsonl");
    const header = { type: "session", id: "session-a" };
    const firstMessage = assistant();
    const switchModel = { type: "model_change", provider: "custom", modelId: "model-b" };
    const compact = { type: "compaction", id: "compact", timestamp, usage };
    const unfinishedSwitch = JSON.stringify({
      type: "model_change",
      provider: "custom",
      modelId: "model-c",
    });
    await NodeFSP.writeFile(
      path,
      [header, firstMessage, switchModel].map((entry) => JSON.stringify(entry)).join("\n") +
        "\n" +
        unfinishedSwitch,
    );
    const first = await readTranscriptRecords(path, "pi");
    expect(first).not.toBeNull();
    expect(first!.position.piState?.model).toBe("custom/model-b");
    const cache: ScanCache = new Map([
      [
        path,
        {
          size: (await NodeFSP.stat(path)).size,
          mtimeMs: 1,
          provider: "pi",
          records: first!.records,
          tailRecords: first!.tailRecords,
          position: first!.position,
        },
      ],
    ]);
    const restored = decodeScanCache(JSON.parse(JSON.stringify(encodeScanCache(cache)))).get(path)!;
    expect(restored).toEqual(cache.get(path));
    await NodeFSP.appendFile(path, "\n" + JSON.stringify(compact) + "\n");
    const appended = await readTranscriptRecords(path, "pi", restored.position);
    expect(appended?.resumed).toBe(true);
    expect(appended?.records[0]?.model).toBe("custom/model-c");
    expect(appended?.records[0]?.sessionId).toBe("session-a");
    const full = await readTranscriptRecords(path, "pi");
    expect([...restored.records, ...appended!.records]).toEqual(full?.records);
  });

  it("projects usage from large JSONL records without losing metadata", async () => {
    const path = NodePath.join(dir, "large.jsonl");
    const entry = assistant();
    await NodeFSP.writeFile(
      path,
      JSON.stringify({ type: "session", id: "session-a" }) +
        "\n" +
        JSON.stringify({
          ...entry,
          message: {
            ...entry.message,
            content: [{ type: "text", text: "ignored".repeat(100000) }],
          },
        }) +
        "\n",
    );
    const native = await readTranscriptRecords(path, "pi");
    const streaming = await readTranscriptRecords(path, "pi", undefined, {
      streamingThresholdBytes: 64,
    });
    expect(streaming?.records).toEqual(native?.records);
    expect(streaming?.records[0]?.reportedCostUsd).toBe(usage.cost.total);
  });
});
