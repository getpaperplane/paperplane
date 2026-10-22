import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  PiSettings,
} from "@rove-code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderInstanceOverridePatch,
  deriveProviderInstanceId,
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  validateProviderInstanceId,
} from "./providerInstanceSettings.ts";

const pi = { driverKind: ProviderDriverKind.make("pi"), settingsSchema: PiSettings };

describe("deriveProviderSettingsFields", () => {
  it("shows Pi workload fields only when the host supports them", () => {
    const keys = (supported: boolean) =>
      deriveProviderSettingsFields(pi, undefined, supported).map((field) => field.key);
    expect(keys(true)).toEqual(expect.arrayContaining(["workloadProtection", "workloadMemoryMiB"]));
    expect(keys(false)).not.toContain("workloadProtection");
    expect(keys(false)).not.toContain("workloadMemoryMiB");
    expect(keys(false)).not.toContain("enabled");
  });
});

describe("nextProviderConfigWithFieldValue", () => {
  it("omits blank values and returns undefined for an empty config", () => {
    const field = deriveProviderSettingsFields(pi).find((entry) => entry.key === "model")!;
    const set = nextProviderConfigWithFieldValue(undefined, field, "a/b");
    expect(set).toEqual({ model: "a/b" });
    expect(nextProviderConfigWithFieldValue(set, field, "  ")).toBeUndefined();
  });
});

describe("provider instance ids", () => {
  it("derives and validates ids", () => {
    expect(deriveProviderInstanceId("codex", " Work Acct! ")).toBe("codex_work_acct");
    expect(deriveProviderInstanceId("codex", "!!!")).toBe("");
    const existing = new Set(["codex_work"]);
    expect(validateProviderInstanceId("codex_work", existing)).toMatch(/already exists/);
    expect(validateProviderInstanceId("1bad", existing)).toMatch(/start with a letter/);
    expect(validateProviderInstanceId("", existing)).toMatch(/required/);
    expect(validateProviderInstanceId("a".repeat(65), existing)).toMatch(/64/);
    expect(validateProviderInstanceId("codex_new", existing)).toBeNull();
  });
});

describe("buildProviderInstanceOverridePatch", () => {
  it("clears an override entry when nothing remains", () => {
    const projectId = ProjectId.make("p");
    const instanceId = ProviderInstanceId.make("codex");
    const settings = {
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    };
    expect(
      buildProviderInstanceOverridePatch(settings, [projectId], instanceId, undefined),
    ).toEqual({
      [projectId]: null,
    });
  });
});
