import { describe, it, expect } from "vite-plus/test";
import {
  parsePiResumeCursor,
  piContextUsage,
  resolvePiToolCallArgs,
  translatePiSkillToken,
  type PiSessionLike,
} from "./PiAdapter.ts";
const session: PiSessionLike = {
  sessionId: "test",
  isStreaming: false,
  messages: [],
  prompt: async () => {},
  followUp: async () => {},
  abort: async () => {},
  dispose: () => {},
  subscribe: () => () => {},
};
describe("Pi SDK boundary helpers", () => {
  it("validates durable cursors without silently starting fresh", () => {
    expect(
      parsePiResumeCursor({
        sessionId: "id",
        sessionFile: "/tmp/session.jsonl",
        turnBoundaries: [{ turnId: "turn", entryId: null }],
      }),
    ).toEqual({
      sessionId: "id",
      sessionFile: "/tmp/session.jsonl",
      turnBoundaries: [{ turnId: "turn", entryId: null }],
    });
    expect(() => parsePiResumeCursor({ sessionId: "" })).toThrow("Invalid Pi resume cursor");
    expect(() =>
      parsePiResumeCursor({ sessionId: "id", turnBoundaries: [{ turnId: "turn" }] }),
    ).toThrow("turn boundary");
  });
  it("expands only the leading composer skill", () => {
    expect(translatePiSkillToken("$review inspect this")).toBe("/skill:review inspect this");
    expect(translatePiSkillToken("literal $review")).toBe("literal $review");
  });
  it("finds raw SDK tool arguments without reading extension result shapes", () => {
    expect(
      resolvePiToolCallArgs(
        [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call", arguments: { command: "pwd" } }],
          },
        ],
        "call",
      ),
    ).toEqual({ command: "pwd" });
  });
  it("retains authoritative unknown-after-compaction and unavailable context", () => {
    expect(piContextUsage(session)).toEqual({ contextUsageState: "unavailable" });
    expect(
      piContextUsage({
        ...session,
        getSessionStats: () => ({
          contextUsage: { tokens: null, contextWindow: 64000, percent: null },
        }),
      }),
    ).toEqual({
      contextUsageState: "unknown",
      contextUsageUnknownReason: "compacted",
      maxTokens: 64000,
    });
  });
  it("reports disjoint active-branch tokens without double-counting cache", () => {
    const usage = piContextUsage({
      ...session,
      getSessionStats: () => ({ contextUsage: { tokens: 40, contextWindow: 64000, percent: 0.1 } }),
      getBranch: () => [
        {
          id: "assistant",
          type: "message",
          message: {
            role: "assistant",
            usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 3 },
          },
        },
      ],
    });
    expect(usage).toMatchObject({
      usedTokens: 40,
      inputTokens: 33,
      cachedInputTokens: 20,
      cacheCreationTokens: 3,
      outputTokens: 5,
      totalProcessedTokens: 38,
    });
  });
});
