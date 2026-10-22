import { DEFAULT_SERVER_SETTINGS, type ServerConfig } from "@rove-code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeOtlpEndpointStatus,
  describeStorageCleanupCounts,
  hasEnabledCleanupRules,
  parseRetentionDays,
  planEnvironmentIconSetting,
  planWorktreesDirectoryChange,
  resolveEnvironmentIconPickerLock,
  uniformValue,
} from "./environmentAdmin.ts";

const config = (machine?: string, ...[environmentIcon = true]: [boolean?]) =>
  ({
    environment: { capabilities: { environmentIcon }, platform: { machine } },
  }) as unknown as ServerConfig;

describe("environment icon", () => {
  it("explains the first blocker the user can act on", () => {
    expect(
      resolveEnvironmentIconPickerLock({ serverConfig: null, operateAccess: "granted" }),
    ).toMatch(/Connect/);
    expect(
      resolveEnvironmentIconPickerLock({
        serverConfig: config("laptop", false),
        operateAccess: "denied",
      }),
    ).toMatch(/too old/);
    expect(
      resolveEnvironmentIconPickerLock({ serverConfig: config(), operateAccess: "pending" }),
    ).toMatch(/cannot change/);
    expect(
      resolveEnvironmentIconPickerLock({ serverConfig: config(), operateAccess: "granted" }),
    ).toBeNull();
  });

  it("clears the override when the detected kind is picked", () => {
    expect(planEnvironmentIconSetting(config("laptop"), "laptop")).toBeNull();
    expect(planEnvironmentIconSetting(config("laptop"), "cloud")).toBe("cloud");
    expect(planEnvironmentIconSetting(config(), "server")).toBeNull();
    expect(planEnvironmentIconSetting(config(), "toaster")).toBeUndefined();
  });
});

describe("worktrees directory", () => {
  it("trims and skips unchanged values, but writes over mixed ones", () => {
    expect(planWorktreesDirectoryChange(["~/wt"], " ~/wt ")).toBeUndefined();
    expect(planWorktreesDirectoryChange(["~/wt"], "  ")).toBe("");
    expect(planWorktreesDirectoryChange(["a", "b"], "a")).toBe("a");
    expect(planWorktreesDirectoryChange([], "a")).toBe("a");
  });
});

describe("OTLP endpoint status", () => {
  it("only trusts a check made for the current URL", () => {
    const check = { url: "http://a", result: { _tag: "Accepted", latencyMs: 12.4 } } as const;
    expect(describeOtlpEndpointStatus("", check).tone).toBe("off");
    expect(describeOtlpEndpointStatus("http://b", check).label).toBe("Not checked");
    expect(describeOtlpEndpointStatus("http://a", { url: "http://a", result: null }).tone).toBe(
      "pending",
    );
    expect(describeOtlpEndpointStatus("http://a", check).label).toBe("Connected · 12 ms");
    expect(
      describeOtlpEndpointStatus("http://a", {
        url: "http://a",
        result: { _tag: "Unreachable", timedOut: true },
      }).label,
    ).toBe("Timed out");
    expect(
      describeOtlpEndpointStatus("http://a", {
        url: "http://a",
        result: { _tag: "Rejected", status: 404 },
      }).tone,
    ).toBe("failure");
  });
});

describe("storage cleanup", () => {
  it("knows when a run could remove something", () => {
    expect(hasEnabledCleanupRules(DEFAULT_SERVER_SETTINGS)).toBe(false);
    expect(
      hasEnabledCleanupRules({
        ...DEFAULT_SERVER_SETTINGS,
        storageCleanup: { ...DEFAULT_SERVER_SETTINGS.storageCleanup, logsAfterDays: 7 },
      }),
    ).toBe(true);
  });

  it("clamps retention input and rejects non-numbers", () => {
    expect(parseRetentionDays("abc")).toBeNull();
    expect(parseRetentionDays("")).toBeNull();
    expect(parseRetentionDays("0")).toBe(1);
    expect(parseRetentionDays("0", 0)).toBe(0);
    expect(parseRetentionDays("99999")).toBe(3650);
    expect(parseRetentionDays("7.6")).toBe(8);
  });

  it("summarizes counts and mixed values", () => {
    expect(describeStorageCleanupCounts({ removed: 2, kept: 1, failed: 0 })).toBe(
      "2 removed, 1 kept",
    );
    expect(describeStorageCleanupCounts({ removed: 0, kept: 0, failed: 3 })).toContain("3 failed");
    expect(uniformValue([1, 1])).toBe(1);
    expect(uniformValue([1, 2])).toBeUndefined();
    expect(uniformValue([])).toBeUndefined();
  });
});
