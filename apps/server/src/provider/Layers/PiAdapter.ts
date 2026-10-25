/** Narrow public SDK/worker boundary. Orchestration lives in PiAdapterV2, never V1 ingestion. */
import type {
  ProviderUserInputAnswers,
  ThreadId,
  ThreadTokenUsageSnapshot,
} from "@getpaperplane/contracts";
import type { Json } from "effect/Schema";
import { piRecord, piTrimmed } from "./PiValues.ts";

export interface PiImageContentLike {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}
export interface PiSessionModelLike {
  readonly id: string;
  readonly provider?: string;
  readonly input: ReadonlyArray<string>;
}
export interface PiUsageLike {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}
export interface PiSessionEntryLike {
  readonly id: string;
  readonly parentId?: string | null;
  readonly type?: string;
  readonly message?: { readonly role?: string; readonly usage?: PiUsageLike };
  readonly usage?: PiUsageLike;
}
export interface PiSessionStatsLike {
  readonly assistantMessages?: number;
  readonly contextUsage?: {
    readonly tokens: number | null;
    readonly contextWindow: number;
    readonly percent: number | null;
  };
}
export type PiSessionResumeOutcome =
  | { readonly resumed: true; readonly sessionFile: string }
  | { readonly resumed: false; readonly reason: "no-cursor" };
export interface PiSessionEventLike {
  readonly type: string;
  readonly [key: string]: Json;
}
export interface PiSessionLike {
  readonly sessionId: string;
  readonly isStreaming: boolean;
  readonly hasPendingUserInput?: boolean | undefined;
  readonly isPreparingPrompt?: boolean | undefined;
  readonly messages: ReadonlyArray<unknown>;
  readonly sessionFile?: string | undefined;
  readonly resumeOutcome?: PiSessionResumeOutcome | undefined;
  readonly autoCompactionEnabled?: boolean | undefined;
  readonly modelFallbackMessage?: string | undefined;
  prompt(
    text: string,
    options?: {
      readonly images?: Array<PiImageContentLike>;
      readonly streamingBehavior?: "steer" | "followUp";
      readonly preflightResult?: (success: boolean) => void;
    },
  ): Promise<void>;
  followUp(text: string): Promise<void>;
  respondToUserInput?(
    requestId: string,
    answers: ProviderUserInputAnswers,
  ): boolean | Promise<boolean>;
  compact?(): Promise<void>;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
  setModel?(model: string): Promise<void>;
  setThinkingLevel?(level: string): void | Promise<void>;
  getThinkingLevel?(): string;
  getTurnUsageLimit?(
    errorMessage: string,
    observedAt: string,
  ): Promise<{ readonly resetAt: string | null } | null>;
  getModel?(): PiSessionModelLike | undefined;
  subscribe(listener: (event: PiSessionEventLike) => void): () => void;
  getEntries?(): ReadonlyArray<PiSessionEntryLike>;
  getBranch?(): ReadonlyArray<PiSessionEntryLike>;
  getSessionStats?(): PiSessionStatsLike | undefined;
  getLeafId?(): string | undefined;
  fork?(entryId: string | null): Promise<void>;
}
export interface PiCreateSessionInput {
  readonly threadId?: ThreadId;
  readonly interactive?: boolean;
  readonly cwd: string;
  readonly agentDir?: string;
  readonly model: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly resumeSessionId: string | undefined;
  readonly resumeSessionFile?: string | undefined;
  readonly disabledExtensions?: ReadonlyArray<string>;
}
export class PiExtensionLoadError extends Error {
  readonly failedExtensionPaths: ReadonlyArray<string>;
  constructor(message: string, failedExtensionPaths: ReadonlyArray<string>) {
    super(message);
    this.name = "PiExtensionLoadError";
    this.failedExtensionPaths = failedExtensionPaths;
  }
}
export function parsePiResumeCursor(raw: unknown) {
  if (raw === undefined || raw === null) return undefined;
  const record = piRecord(raw);
  const sessionId = piTrimmed(record?.sessionId);
  const sessionFile = piTrimmed(record?.sessionFile);
  if (!sessionId || (record?.sessionFile !== undefined && !sessionFile))
    throw new Error(
      "Invalid Pi resume cursor. Restore the saved session cursor or create a new thread to start fresh.",
    );
  const turnBoundaries: Array<{ turnId: string; entryId: string | null }> = [];
  if (record?.turnBoundaries !== undefined) {
    if (!Array.isArray(record.turnBoundaries))
      throw new Error("Invalid Pi turn boundaries in resume cursor.");
    for (const rawBoundary of record.turnBoundaries) {
      const boundary = piRecord(rawBoundary);
      const turnId = piTrimmed(boundary?.turnId);
      const entryId = boundary?.entryId === null ? null : piTrimmed(boundary?.entryId);
      if (!turnId || entryId === undefined)
        throw new Error("Invalid Pi turn boundary in resume cursor.");
      turnBoundaries.push({ turnId, entryId });
    }
  }
  return { sessionId, ...(sessionFile ? { sessionFile } : {}), turnBoundaries };
}
export function translatePiSkillToken(text: string) {
  return text
    .replace(/^\$([^\s]+)(?:\s+|$)/, (_match, name: string) => `/skill:${name} `)
    .trimEnd();
}
export function resolvePiToolCallArgs(
  messages: ReadonlyArray<unknown>,
  toolCallId: string,
): Record<string, Json> | undefined {
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - 200); i--) {
    const outer = piRecord(messages[i]);
    const message = piRecord(outer?.message) ?? outer;
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      const call = piRecord(block);
      if (call?.type !== "toolCall" || call.id !== toolCallId) continue;
      if (typeof call.arguments !== "string") return piRecord(call.arguments);
      try {
        return piRecord(JSON.parse(call.arguments));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
/** Pi context is authoritative, including unknown-after-compaction and unavailable. */
export function piContextUsage(session: PiSessionLike): ThreadTokenUsageSnapshot {
  const context = session.getSessionStats?.()?.contextUsage;
  if (!context || !Number.isFinite(context.contextWindow) || context.contextWindow <= 0)
    return { contextUsageState: "unavailable" };
  const maxTokens = Math.round(context.contextWindow);
  const auto =
    session.autoCompactionEnabled === undefined
      ? {}
      : { compactsAutomatically: session.autoCompactionEnabled };
  const entries = session.getBranch?.();
  let total = 0,
    input = 0,
    cached = 0,
    write = 0,
    output = 0;
  let hasUsage = false;
  for (const entry of entries ?? []) {
    const usage = entry.usage ?? entry.message?.usage;
    if (!usage) continue;
    hasUsage = true;
    const safe = (n: number | undefined) =>
      n !== undefined && Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
    input += safe(usage.input);
    cached += safe(usage.cacheRead);
    write += safe(usage.cacheWrite);
    output += safe(usage.output);
  }
  total = input + cached + write + output;
  const processed = hasUsage
    ? { totalProcessedTokens: total, totalProcessedTokensScope: "activeBranch" as const }
    : {};
  if (context.tokens === null)
    return {
      contextUsageState: "unknown",
      contextUsageUnknownReason: "compacted",
      maxTokens,
      ...auto,
      ...processed,
    };
  if (!Number.isFinite(context.tokens) || context.tokens < 0)
    return { contextUsageState: "unavailable" };
  return {
    usedTokens: Math.round(context.tokens),
    maxTokens,
    ...auto,
    ...processed,
    ...(hasUsage
      ? {
          inputTokens: input + cached + write,
          cachedInputTokens: cached,
          cacheCreationTokens: write,
          outputTokens: output,
          tokenBreakdownScope: "activeBranch" as const,
        }
      : {}),
  };
}
