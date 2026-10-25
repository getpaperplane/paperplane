import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";
import { createPiUsageLimitCapture } from "./PiUsageLimitCapture.ts";

type Stream = AgentSession["agent"]["streamFunction"];
const model: Model<"openai-codex-responses"> = {
  id: "synthetic",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://example.invalid",
  name: "Synthetic",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
};
const reset = 2000100000;
const resetAt = "2033-05-19T07:20:00.000Z";
const limited = { type: "error", error: { type: "usage_limit_reached", resets_at: reset } };
const context = normalizeContext({ messages: [] });

function fixture(events: ReadonlyArray<unknown>) {
  const agent: Pick<AgentSession["agent"], "streamFunction"> = {
    streamFunction: async (_model, _context, options) => {
      for (const event of events) await options?.onProviderStreamEvent?.(event, model);
      return createAssistantMessageEventStream();
    },
  };
  const capture = createPiUsageLimitCapture();
  capture.observe(agent);
  return { capture, agent };
}

describe("Pi request quota evidence", () => {
  it("combines a native quota event with an opaque nested limit error", async () => {
    const { capture, agent } = fixture([
      {
        type: "codex.rate_limits",
        rate_limits: { primary: { used_percent: 100, reset_at: reset } },
      },
      {
        type: "response.failed",
        response: { error: { code: "usage_limit_reached", message: "Opaque failure" } },
      },
    ]);
    await agent.streamFunction(model, context);
    expect(capture.take()?.status).toEqual({
      type: "limited",
      resetAt,
    });
  });

  it("clears a rejected attempt when a later WebSocket response succeeds or fails differently", async () => {
    for (const finalEvent of [
      { type: "response.completed" },
      { type: "error", error: { type: "server_error" } },
    ]) {
      const { capture, agent } = fixture([limited, finalEvent]);
      await agent.streamFunction(model, context);
      expect(capture.take()?.status).toEqual({ type: "available" });
    }
  });

  it("merges partial quota updates without losing a blocked window", async () => {
    const { capture, agent } = fixture([
      { type: "codex.rate_limits", rate_limits: { primary: { used_percent: 100 } } },
      {
        type: "codex.rate_limits",
        rate_limits: { secondary: { used_percent: 100, reset_at: reset } },
      },
      { type: "error", error: { type: "usage_limit_reached" } },
    ]);
    await agent.streamFunction(model, context);
    expect(capture.take()?.status).toEqual({ type: "limited", resetAt: null });
  });

  it("does not let a previous request supply the next request's reset", async () => {
    let request = 0;
    const stream: Stream = async (_model, _context, options) => {
      if (request++ === 0) await options?.onProviderStreamEvent?.(limited, model);
      return createAssistantMessageEventStream();
    };
    const agent = { streamFunction: stream };
    const capture = createPiUsageLimitCapture();
    capture.observe(agent);
    await agent.streamFunction(model, context);
    expect(capture.take()?.status).toEqual({
      type: "limited",
      resetAt,
    });
    await agent.streamFunction(model, context);
    expect(capture.take()?.status).toEqual({ type: "unavailable" });
  });

  it("keeps the actual routed model with its evidence and forwards SDK hooks", async () => {
    const routed = { ...model, id: "routed-model" };
    let forwarded = 0;
    const stream: Stream = async (_model, _context, options) => {
      await options?.onProviderStreamEvent?.(limited, routed);
      return createAssistantMessageEventStream();
    };
    const agent = { streamFunction: stream };
    const capture = createPiUsageLimitCapture();
    capture.observe(agent);
    await agent.streamFunction(model, context, {
      onProviderStreamEvent: () => {
        forwarded++;
      },
    });
    expect(capture.take()).toEqual({
      model: routed,
      status: { type: "limited", resetAt },
    });
    expect(forwarded).toBe(1);
  });

  it("leaves an opaque 429 available for quota lookup while excluding authentication errors", async () => {
    for (const [status, expected] of [
      [429, { type: "unavailable" }],
      [401, { type: "available" }],
    ] as const) {
      const stream: Stream = async (_model, _context, options) => {
        await options?.fetch?.("https://example.invalid", {});
        return createAssistantMessageEventStream();
      };
      const agent = { streamFunction: stream };
      const capture = createPiUsageLimitCapture();
      capture.observe(agent);
      await agent.streamFunction(model, context, {
        fetch: async () => Response.json({ message: "Opaque response" }, { status }),
      });
      expect(capture.take()?.status).toEqual(expected);
    }
  });

  it("keeps simultaneous requests from overwriting the latest request's evidence", async () => {
    const first = Promise.withResolvers<void>();
    let count = 0;
    const stream: Stream = async (_model, _context, options) => {
      if (count++ === 0) await first.promise;
      await options?.onProviderStreamEvent?.(limited, model);
      return createAssistantMessageEventStream();
    };
    const agent = { streamFunction: stream };
    const capture = createPiUsageLimitCapture();
    capture.observe(agent);
    const older = agent.streamFunction(model, context);
    await agent.streamFunction(model, context);
    expect(capture.take()?.status).toEqual({ type: "limited", resetAt });
    first.resolve();
    await older;
    expect(capture.take()).toBeNull();
  });
});
