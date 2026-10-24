import {
  OrchestrationV2ProviderThread,
  type ThreadTokenUsageSnapshot,
} from "@getpaperplane/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { contextUsageForHandoff, handoffBudget } from "./handoffBudget.ts";

const providerThread = (contextUsage: ThreadTokenUsageSnapshot) =>
  Schema.decodeUnknownSync(OrchestrationV2ProviderThread)({
    id: "provider-thread",
    driver: "pi",
    providerInstanceId: "pi",
    providerSessionId: null,
    appThreadId: "thread",
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    contextUsage,
    createdAt: DateTime.makeUnsafe("2026-04-10T00:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-04-10T00:00:00.000Z"),
  });

const budget = (usage: ThreadTokenUsageSnapshot) =>
  handoffBudget({
    tokenCap: 64_000,
    userText: "",
    attachments: [],
    providerThread: providerThread(usage),
    nativeContextEstimate: 20_000,
    modelContextWindow: 100_000,
  });

describe("handoff context usage", () => {
  it("uses live occupancy and the automatic compaction threshold when known", () => {
    expect(budget({ usedTokens: 60_000, maxTokens: 100_000 })).toBe(14_998);
    expect(budget({ usedTokens: 60_000, maxTokens: 100_000, autoCompactThreshold: 80_000 })).toBe(
      0,
    );
  });

  it("uses the estimated occupancy and reported window after compaction", () => {
    expect(budget({ contextUsageState: "unknown", maxTokens: 80_000 })).toBe(39_998);
  });

  it("uses the model window and estimated occupancy when telemetry is unavailable", () => {
    expect(budget({ contextUsageState: "unavailable" })).toBe(54_998);
  });

  it("keeps unknown occupancy unknown when changing models on a native thread", () => {
    expect(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: false,
        reuseTelemetry: false,
        previousUsage: {
          contextUsageState: "unknown",
          contextUsageUnknownReason: "compacted",
          maxTokens: 80_000,
        },
        knownModelWindow: 100_000,
      }),
    ).toEqual({
      contextUsageState: "unknown",
      contextUsageUnknownReason: "compacted",
      maxTokens: 100_000,
    });
  });

  it("does not revive unavailable telemetry or reuse usage from another native thread", () => {
    const previousUsage = { contextUsageState: "unavailable" } as const;
    expect(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: false,
        reuseTelemetry: false,
        previousUsage,
      }),
    ).toBeNull();
    expect(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: true,
        reuseTelemetry: true,
        previousUsage,
      }),
    ).toEqual(previousUsage);
    expect(
      contextUsageForHandoff({
        sameNativeThread: false,
        sameSelection: true,
        reuseTelemetry: true,
        previousUsage: { usedTokens: 1_000 },
      }),
    ).toBeNull();
  });
});
