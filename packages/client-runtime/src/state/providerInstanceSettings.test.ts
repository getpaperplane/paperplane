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
  finalizeProviderEnvironment,
  newEnvironmentRow,
  readProviderCommandArgs,
  setEnvironmentRowSensitive,
  setEnvironmentRowValue,
  validateAcpRegistryConfig,
  validateProviderEnvironment,
  withProviderCommandArgs,
  nextProviderConfigWithFieldValue,
  validateProviderInstanceId,
  validateProviderSettingsConfig,
} from "./providerInstanceSettings.ts";

const pi = { driverKind: ProviderDriverKind.make("pi"), settingsSchema: PiSettings };

describe("schema validation before serialized save", () => {
  it("rejects invalid Pi memory and accepts auto and the boundary", () => {
    const field = deriveProviderSettingsFields(pi).find(
      (entry) => entry.key === "workloadMemoryMiB",
    )!;
    for (const value of ["garbage", "383", "384.5", "auto", "384", "4096"]) {
      const config = JSON.parse(JSON.stringify(nextProviderConfigWithFieldValue({}, field, value)));
      expect(validateProviderSettingsConfig(pi, config) === null).toBe(
        ["auto", "384", "4096"].includes(value),
      );
    }
  });
});

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

describe("provider environment variables", () => {
  const redacted = { name: "API_KEY", value: "", sensitive: true, valueRedacted: true };

  it("keeps a redacted secret untouched and replaces it only on input", () => {
    expect(finalizeProviderEnvironment([redacted])).toEqual([redacted]);
    expect(setEnvironmentRowValue(redacted, "new")).toEqual({
      name: "API_KEY",
      value: "new",
      sensitive: true,
    });
    expect(setEnvironmentRowSensitive(redacted, false)).toEqual({
      name: "API_KEY",
      value: "",
      sensitive: false,
    });
  });

  it("drops blank rows, trims names and rejects invalid or duplicate names", () => {
    const rows = [newEnvironmentRow(), { name: " FOO ", value: "1", sensitive: false }];
    expect(finalizeProviderEnvironment(rows)).toEqual([
      { name: "FOO", value: "1", sensitive: false },
    ]);
    expect(validateProviderEnvironment(rows)).toBeNull();
    expect(validateProviderEnvironment([{ name: "1x", value: "", sensitive: false }])).toMatch(
      /not a valid/,
    );
    expect(
      validateProviderEnvironment([
        { name: "A", value: "", sensitive: false },
        { name: "A", value: "", sensitive: false },
      ]),
    ).toMatch(/more than once/);
  });
});

describe("ACP local command", () => {
  it("edits arguments without losing hidden config fields", () => {
    const config = {
      source: "local",
      commandPath: "dsh",
      customModels: ["m"],
      distribution: "auto",
    };
    expect(withProviderCommandArgs(config, ["--a", "b c"])).toEqual({
      ...config,
      commandArgs: ["--a", "b c"],
    });
    expect(readProviderCommandArgs({ commandArgs: ["x", 1] })).toEqual(["x"]);
  });

  it("explains an unusable configuration", () => {
    expect(validateAcpRegistryConfig({ source: "local" })).toMatch(/executable/);
    expect(validateAcpRegistryConfig({ source: "local", commandPath: "dsh" })).toBeNull();
    expect(validateAcpRegistryConfig({})).toMatch(/Choose an agent/);
    expect(validateAcpRegistryConfig({ agentId: "devin" })).toBeNull();
  });
});
