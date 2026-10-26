export type CompactionReason = "context-pressure" | "cache-expiry";

interface CompactionUsage {
  readonly usedTokens: number | null | undefined;
  readonly maxTokens?: number | null | undefined;
  readonly autoCompactThreshold?: number | null | undefined;
  readonly promptCacheExpiresAt?: string | null | undefined;
}

/** A warning precedes Pi's native threshold; native automatic compaction stays authoritative. */
export function hasContextPressure(usage: CompactionUsage): boolean {
  const threshold = usage.autoCompactThreshold ?? usage.maxTokens;
  return (
    threshold != null &&
    threshold > 0 &&
    usage.usedTokens != null &&
    usage.usedTokens >= Math.floor(threshold * 0.9)
  );
}

export function promptCacheCompactionDueAt(
  input: CompactionUsage & {
    readonly provider: string | null | undefined;
    readonly updatedAt?: string | null | undefined;
    readonly promptCacheTtlMs?: number | null | undefined;
  },
): number | null {
  if (input.provider !== "pi" && input.provider !== "claudeAgent") return null;
  const minimumTokens = Math.min(100_000, (input.maxTokens ?? 200_000) / 2);
  if ((input.usedTokens ?? 0) < minimumTokens) return null;
  const expiry = input.promptCacheExpiresAt;
  if (expiry != null) {
    const dueAt = Date.parse(expiry);
    return Number.isFinite(dueAt) ? dueAt : null;
  }
  // Only Claude has the established legacy fallback. Pi requires request evidence.
  if (input.provider !== "claudeAgent") return null;
  const reportedAt = Date.parse(input.updatedAt ?? "");
  return Number.isFinite(reportedAt) ? reportedAt + (input.promptCacheTtlMs ?? 70 * 60_000) : null;
}

export function compactionReasonDescription(reason: CompactionReason): string {
  return reason === "context-pressure"
    ? "Context nearly full. Compact before sending to make room."
    : "Prompt cache may have expired. Compact before sending to reduce input size.";
}
