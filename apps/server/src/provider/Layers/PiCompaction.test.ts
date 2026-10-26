// @effect-diagnostics nodeBuiltinImport:off - Isolated SDK configuration and a local API fixture.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as DateTime from "effect/DateTime";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { piPromptCacheTtlMs } from "./PiCompaction.ts";
import { createPiSession } from "./PiSessionFactory.ts";
import { piRecord } from "./PiValues.ts";

const model = {
  id: "custom-model",
  name: "Custom model",
  provider: "custom-provider",
  api: "openai-completions",
  baseUrl: "https://custom.example/v1",
  reasoning: false,
  input: ["text" as const],
  contextWindow: 128000,
  maxTokens: 8192,
  cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
};

describe("Pi prompt-cache estimates", () => {
  it("uses custom model lifetimes and the request's retention tier", () => {
    const custom = { ...model, promptCache: { short: 300, long: 3600 } };
    expect(piPromptCacheTtlMs(custom, { cacheRetention: "short" }, {})).toBe(300000);
    expect(piPromptCacheTtlMs(custom, { cacheRetention: "long" }, {})).toBe(3600000);
    expect(piPromptCacheTtlMs(custom, { env: { PI_CACHE_RETENTION: "long" } }, {})).toBe(3600000);
    expect(piPromptCacheTtlMs(custom, { cacheRetention: "none" }, {})).toBeUndefined();
  });
  it("reads the final Anthropic payload, including mixed breakpoint lifetimes", () => {
    const anthropic = { ...model, api: "anthropic-messages" };
    expect(
      piPromptCacheTtlMs(
        anthropic,
        {},
        {
          system: [{ cache_control: { type: "ephemeral", ttl: "1h" } }],
          messages: [{ content: [{ cache_control: { type: "ephemeral" } }] }],
        },
      ),
    ).toBe(300000);
    expect(piPromptCacheTtlMs(anthropic, {}, {})).toBeUndefined();
  });
  it("uses native OpenAI retention without guessing from a compatible API", () => {
    expect(piPromptCacheTtlMs(model, {}, { prompt_cache_options: { ttl: "30m" } })).toBe(1800000);
    expect(piPromptCacheTtlMs(model, {}, { prompt_cache_options: { ttl: "12h" } })).toBe(43200000);
    expect(
      piPromptCacheTtlMs(
        model,
        {},
        {
          messages: [{ content: [{ cache_control: { type: "ephemeral", ttl: "1h" } }] }],
        },
      ),
    ).toBe(3600000);
    expect(piPromptCacheTtlMs({ ...model, baseUrl: "https://api.openai.com/v1" }, {}, {})).toBe(
      300000,
    );
    expect(
      piPromptCacheTtlMs(
        { ...model, baseUrl: "https://api.openai.com/v1" },
        {},
        {
          prompt_cache_retention: "24h",
        },
      ),
    ).toBe(86400000);
    expect(piPromptCacheTtlMs(model, {}, {})).toBeUndefined();
    expect(piPromptCacheTtlMs({ ...model, promptCache: { short: 0 } }, {}, {})).toBeUndefined();
  });
});

describe("Pi cache timing through models.json and auth.json", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("persists the custom provider estimate across resume and honors cache warm-ups", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "paperplane-pi-cache-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", root);
    vi.stubEnv("PI_OFFLINE", "1");
    const server = NodeHttp.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "custom-model",
      };
      response.end(
        [
          {
            ...chunk,
            choices: [
              { index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null },
            ],
          },
          {
            ...chunk,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 80000,
              completion_tokens: 4,
              total_tokens: 80004,
              prompt_tokens_details: { cached_tokens: 60000 },
            },
          },
        ]
          .map((value) => `data: ${JSON.stringify(value)}\n\n`)
          .join("") + "data: [DONE]\n\n",
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const sessions = [];
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Expected TCP fixture");
      NodeFS.writeFileSync(
        NodePath.join(root, "models.json"),
        JSON.stringify({
          providers: {
            "custom-provider": {
              api: "openai-completions",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              models: [
                {
                  id: model.id,
                  name: model.name,
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 128000,
                  maxTokens: 8192,
                  cost: model.cost,
                  promptCache: { short: 300, long: 3600 },
                },
              ],
            },
          },
        }),
      );
      NodeFS.writeFileSync(
        NodePath.join(root, "auth.json"),
        JSON.stringify({
          "custom-provider": { type: "api_key", key: "fixture-key" },
        }),
      );
      NodeFS.writeFileSync(
        NodePath.join(root, "settings.json"),
        JSON.stringify({
          compaction: {
            modelOverrides: { "custom-provider/custom-model": { reserveTokens: 28000 } },
          },
        }),
      );
      const first = await createPiSession(
        {
          cwd: root,
          model: "custom-provider/custom-model",
          thinkingLevel: "off",
          resumeSessionId: undefined,
        },
        { extensions: false },
      );
      sessions.push(first);
      const before = DateTime.toEpochMillis(DateTime.nowUnsafe());
      await first.prompt("Remember this context.");
      expect(piRecord(first.messages.at(-1))?.errorMessage).toBeUndefined();
      expect(first.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
      const status = first.getCompactionStatus?.();
      expect(status).toMatchObject({
        contextModel: "custom-provider/custom-model",
        autoCompactThreshold: 100000,
        promptCacheTtlMs: 300000,
      });
      expect(Date.parse(status?.promptCacheExpiresAt ?? "")).toBeGreaterThanOrEqual(
        before + 300000,
      );
      await first.dispose();
      const resumed = await createPiSession(
        {
          cwd: root,
          model: "custom-provider/custom-model",
          thinkingLevel: "off",
          resumeSessionId: first.sessionId,
          resumeSessionFile: first.sessionFile,
        },
        { extensions: false },
      );
      sessions.push(resumed);
      expect(resumed.getCompactionStatus?.()).toEqual(status);
      await resumed.dispose();

      if (!first.sessionFile) throw new Error("Expected persisted session");
      const saved = SessionManager.open(first.sessionFile);
      const usage = {
        input: 0,
        output: 1,
        cacheRead: 80000,
        cacheWrite: 0,
        totalTokens: 80001,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      saved.appendUsage("cache_warm", "custom-provider", "custom-model", usage);
      const warm = saved.getBranch().at(-1);
      if (!warm) throw new Error("Expected cache-warming usage entry");
      const warmed = await createPiSession(
        {
          cwd: root,
          model: "custom-provider/custom-model",
          thinkingLevel: "off",
          resumeSessionId: first.sessionId,
          resumeSessionFile: first.sessionFile,
        },
        { extensions: false },
      );
      sessions.push(warmed);
      expect(warmed.getCompactionStatus?.()?.promptCacheExpiresAt).toBe(
        DateTime.formatIso(DateTime.makeUnsafe(Date.parse(warm.timestamp) + 300000)),
      );
    } finally {
      for (const session of sessions) await session.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
