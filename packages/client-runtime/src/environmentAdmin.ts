/**
 * Environment admin decisions shared by web and mobile Settings: storage
 * cleanup, worktrees directory, OTLP endpoint checks and environment icons.
 * The server stays authoritative; these only decide what to offer and send.
 */
import {
  isEnvironmentMachineKind,
  type EnvironmentMachineKind,
  type OtlpEndpointCheckResult,
  type ServerConfig,
  type ServerSettings,
  type StorageCleanupReportEntry,
  type WorktreeCleanupRules,
} from "@getpaperplane/contracts";
import { resolveWorktreeCleanup } from "@getpaperplane/shared/projectSettings";

// --- Environment icon -------------------------------------------------------

/**
 * Why the icon picker is inert, in the order the user can do something about
 * it. Null means it can be changed.
 */
export function resolveEnvironmentIconPickerLock(input: {
  readonly serverConfig: ServerConfig | null;
  readonly operateAccess: "granted" | "denied" | "pending";
}): string | null {
  if (input.serverConfig === null) {
    return "Connect to this environment to change its icon.";
  }
  if (input.serverConfig.environment.capabilities.environmentIcon !== true) {
    return "This environment's server is too old to keep an icon. Update it to choose one.";
  }
  if (input.operateAccess !== "granted") {
    return "Your session on this environment cannot change its settings.";
  }
  return null;
}

/** The kind the server detected; with no detection it falls back to "server". */
export function detectedEnvironmentMachineKind(
  serverConfig: ServerConfig | null,
): EnvironmentMachineKind {
  return serverConfig?.environment.platform.machine ?? "server";
}

/**
 * The `environmentIcon` value to save for a pick. Picking the detected kind
 * clears the override (null), which is also the reset path. Undefined means
 * the pick is not a valid kind and nothing should be sent.
 */
export function planEnvironmentIconSetting(
  serverConfig: ServerConfig | null,
  picked: string,
): EnvironmentMachineKind | null | undefined {
  if (!isEnvironmentMachineKind(picked)) return undefined;
  return picked === detectedEnvironmentMachineKind(serverConfig) ? null : picked;
}

// --- Worktrees directory ----------------------------------------------------

/**
 * The value to save when the field is committed, or undefined when it would
 * not change anything. Path validation and expansion happen on the
 * destination server, so the text is only trimmed here.
 */
export function planWorktreesDirectoryChange(
  currentValues: readonly string[],
  draft: string,
): string | undefined {
  const value = draft.trim();
  return currentValues.length > 0 && currentValues.every((current) => current === value)
    ? undefined
    : value;
}

// --- OTLP endpoint check ----------------------------------------------------

export const isOtlpHttpUrl = (url: string) => {
  if (!/^https?:\/\/./i.test(url)) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
};

/** Empty disables export; reachability is deliberately not a save requirement. */
export const isOtlpEndpointInputValid = (url: string) =>
  url.trim() === "" || isOtlpHttpUrl(url.trim());

export type OtlpEndpointStatusTone = "off" | "idle" | "pending" | "success" | "failure";

/** The latest check for a field; it describes the field only while `url` is its value. */
export interface OtlpEndpointCheck {
  readonly url: string;
  readonly result: OtlpEndpointCheckResult | null;
}

export function describeOtlpEndpointStatus(
  url: string,
  check: OtlpEndpointCheck | undefined,
): { readonly label: string; readonly tone: OtlpEndpointStatusTone } {
  if (url === "") return { label: "Off", tone: "off" };
  if (check?.url !== url) return { label: "Not checked", tone: "idle" };
  const { result } = check;
  if (result === null) return { label: "Checking…", tone: "pending" };
  switch (result._tag) {
    case "Accepted":
      return { label: `Connected · ${Math.round(result.latencyMs)} ms`, tone: "success" };
    case "Rejected":
      return { label: `Rejected · HTTP ${result.status}`, tone: "failure" };
    case "Unreachable":
      return { label: result.timedOut ? "Timed out" : "Unreachable", tone: "failure" };
  }
}

// --- Storage cleanup --------------------------------------------------------

function cleanupRulesEnabled(rules: WorktreeCleanupRules) {
  return (
    rules.worktreeAfterDays !== null ||
    rules.worktreeSettledAfterDays !== null ||
    rules.worktreeOnMerge ||
    rules.worktreeOnDelete ||
    rules.worktreeUnchanged
  );
}

/** Whether a cleanup run could remove anything under these settings. */
export function hasEnabledCleanupRules(settings: ServerSettings): boolean {
  return (
    settings.storageCleanup.browserArtifactsAfterDays !== null ||
    settings.storageCleanup.logsAfterDays !== null ||
    cleanupRulesEnabled(resolveWorktreeCleanup(settings, null)) ||
    Object.values(settings.projectSettingsOverrides).some(
      (override) =>
        override.worktreeCleanup?.mode === "custom" &&
        cleanupRulesEnabled(override.worktreeCleanup.rules),
    )
  );
}

export function storageCleanupEntryName(entry: StorageCleanupReportEntry): string {
  if (entry.kind === "logs") return "Rotated logs";
  if (entry.kind === "browser-artifacts") return "Browser artifacts";
  return (
    (entry.threadId === null ? entry.path : entry.path?.split(/[\\/]/).findLast(Boolean)) ??
    "Worktrees"
  );
}

export function describeStorageCleanupCounts(counts: {
  readonly removed: number;
  readonly kept: number;
  readonly failed: number;
}): string {
  return `${counts.removed} removed, ${counts.kept} kept${counts.failed > 0 ? `, ${counts.failed} failed` : ""}`;
}

/**
 * Parses a retention field in days. Null means the text is not a usable
 * number (leave the saved value alone); valid numbers clamp to the contract's
 * range and round to whole days.
 */
export function parseRetentionDays(text: string, minimum = 1): number | null {
  const value = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(value)) return null;
  return Math.min(3650, Math.max(minimum, Math.round(value)));
}

/** The shared value across environments, or undefined when they disagree. */
export function uniformValue<T>(values: readonly T[]): T | undefined {
  const [first] = values;
  return values.length > 0 && values.every((value) => value === first) ? first : undefined;
}
