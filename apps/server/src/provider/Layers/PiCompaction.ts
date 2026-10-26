import type { AgentSession } from "@earendil-works/pi-coding-agent";
import * as DateTime from "effect/DateTime";
import { piRecord } from "./PiValues.ts";

type StreamModel = Parameters<AgentSession["agent"]["streamFunction"]>[0];
type StreamOptions = Parameters<AgentSession["agent"]["streamFunction"]>[2];

const CACHE_ENTRY = "paperplane.prompt-cache";

/** Read the effective request, after auth, model routing, and payload extensions. */
export function piPromptCacheTtlMs(model: StreamModel, options: StreamOptions, payload: unknown) {
  if (options?.cacheRetention === "none") return undefined;
  const body = piRecord(payload);
  const retention = body?.prompt_cache_retention;
  const explicitTtl = piRecord(body?.prompt_cache_options)?.ttl;
  let tier: "short" | "long" =
    retention === "24h" ||
    explicitTtl === "12h" ||
    (retention === undefined &&
      (options?.cacheRetention ??
        options?.env?.PI_CACHE_RETENTION ??
        process.env.PI_CACHE_RETENTION) === "long")
      ? "long"
      : "short";
  // Anthropic breakpoints also appear in OpenAI-compatible gateway requests.
  if (model.api === "anthropic-messages" || payload !== undefined) {
    const lifetimes: number[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      const record = piRecord(value);
      if (!record) return;
      const control = piRecord(record.cache_control);
      if (control?.type === "ephemeral") lifetimes.push(control.ttl === "1h" ? 3600000 : 300000);
      for (const [key, child] of Object.entries(record)) {
        if (key !== "cache_control") visit(child);
      }
    };
    visit(payload);
    if (lifetimes.length > 0) {
      const wireTtl = Math.min(...lifetimes);
      tier = wireTtl === 3600000 ? "long" : "short";
      const seconds = model.promptCache?.[tier];
      return seconds === undefined
        ? wireTtl
        : seconds > 0
          ? Math.min(wireTtl, seconds * 1000)
          : undefined;
    }
    if (model.api === "anthropic-messages") return undefined;
  }
  if (explicitTtl === "30m") return 30 * 60_000;
  if (explicitTtl === "12h") return 12 * 60 * 60_000;
  const declared = model.promptCache?.[tier];
  if (declared !== undefined) return declared > 0 ? declared * 1000 : undefined;
  // Automatic OpenAI caching has a conservative five-minute inactivity estimate.
  // An OpenAI-compatible API alone does not establish a custom endpoint's TTL.
  const host = URL.parse(model.baseUrl ?? "")?.hostname;
  if (host === "api.openai.com" || host === "chatgpt.com")
    return retention === "24h" ? 24 * 60 * 60_000 : 5 * 60_000;
  return undefined;
}

/** Persist only cache timing, never auth, request bodies, or prompts. */
export function observePiPromptCache(session: AgentSession) {
  const stream = session.agent.streamFunction;
  let request: { model: StreamModel; ttlMs: number | undefined; startedAt: number } | undefined;
  session.agent.streamFunction = (model, context, options) => {
    const current = {
      model,
      ttlMs:
        model.api === "anthropic-messages"
          ? undefined
          : piPromptCacheTtlMs(model, options, undefined),
      startedAt: DateTime.toEpochMillis(DateTime.nowUnsafe()),
    };
    request = current;
    return stream(model, context, {
      ...options,
      onPayload: async (payload, actualModel) => {
        const replacement = await options?.onPayload?.(payload, actualModel);
        current.model = actualModel;
        current.startedAt = DateTime.toEpochMillis(DateTime.nowUnsafe());
        current.ttlMs = piPromptCacheTtlMs(
          actualModel,
          options,
          replacement === undefined ? payload : replacement,
        );
        return replacement;
      },
    });
  };
  return session.subscribe((event) => {
    if (event.type !== "message_end" || event.message.role !== "assistant" || !request) return;
    const { model, ttlMs, startedAt } = request;
    request = undefined;
    if (event.message.stopReason === "error" || event.message.stopReason === "aborted") return;
    session.sessionManager.appendCustomEntry(CACHE_ENTRY, {
      model: `${model.provider}/${model.id}`,
      ttlMs: ttlMs ?? null,
      expiresAt:
        ttlMs === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(startedAt + ttlMs)),
    });
  });
}

export function piCompactionStatus(session: AgentSession) {
  const model = session.model;
  if (!model) return undefined;
  const contextModel = `${model.provider}/${model.id}`;
  const settings = session.settingsManager.getCompactionSettings(model);
  let warmedAt: number | undefined;
  let cache: { promptCacheTtlMs: number; promptCacheExpiresAt: string } | undefined;
  const branch = session.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    if (
      entry.type === "compaction" ||
      entry.type === "branch_summary" ||
      entry.type === "context_edit" ||
      entry.type === "model_change"
    )
      break;
    if (
      entry.type === "usage" &&
      entry.kind === "cache_warm" &&
      entry.provider === model.provider &&
      entry.model === model.id &&
      entry.usage.cacheRead > 0
    )
      warmedAt ??= Date.parse(entry.timestamp);
    if (entry.type !== "custom" || entry.customType !== CACHE_ENTRY) continue;
    const data = piRecord(entry.data);
    if (data?.model !== contextModel) break;
    if (typeof data.ttlMs === "number" && data.ttlMs > 0 && typeof data.expiresAt === "string") {
      const expires = Date.parse(data.expiresAt);
      if (Number.isFinite(expires))
        cache = {
          promptCacheTtlMs: data.ttlMs,
          promptCacheExpiresAt: DateTime.formatIso(
            DateTime.makeUnsafe(Math.max(expires, (warmedAt ?? -Infinity) + data.ttlMs)),
          ),
        };
    }
    break;
  }
  return {
    contextModel,
    autoCompactThreshold: Math.max(1, model.contextWindow - settings.reserveTokens),
    ...cache,
  };
}
