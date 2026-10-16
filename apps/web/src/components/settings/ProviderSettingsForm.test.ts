import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ServerProviderModel } from "@rove-code/contracts";

import { providerClients } from "./providerDriverMeta";
import { resolvePiSubagentSettings } from "./PiSubagentSettings";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  resolvePiThinkingSetting,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  const piModels: ReadonlyArray<ServerProviderModel> = [
    {
      slug: "local/reasoning",
      name: "Reasoning",
      isCustom: false,
      isDefault: true,
      capabilities: {
        optionDescriptors: [
          {
            id: "thinkingLevel",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low", isDefault: true },
              { id: "max", label: "Max" },
            ],
            currentValue: "low",
          },
        ],
      },
    },
    {
      slug: "local/plain",
      name: "Plain",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "thinkingLevel",
            label: "Reasoning",
            type: "select",
            options: [{ id: "off", label: "Off", isDefault: true }],
            currentValue: "off",
          },
        ],
      },
    },
  ];

  it("preserves subagent inheritance and unavailable overrides without altering the thread model", () => {
    expect(resolvePiSubagentSettings({}, piModels)).toMatchObject({
      model: "",
      thinking: "",
      thinkingUnavailable: false,
    });
    const missing = resolvePiSubagentSettings(
      {
        subagentModel: "missing/model",
        subagentThinkingLevel: "max",
      },
      piModels,
    );
    expect(missing).toMatchObject({ model: "missing/model", thinkingUnavailable: true });
    expect(missing.modelOptions.at(-1)).toMatchObject({
      slug: "missing/model",
      isUnavailable: true,
    });
    const pi = providerClients.get(ProviderDriverKind.make("pi"))!;
    const field = deriveProviderSettingsFields(pi).find((field) => field.key === "subagentModel")!;
    expect(
      nextProviderConfigWithFieldValue(
        { model: "local/reasoning", subagentModel: "missing/model" },
        field,
        "",
      ),
    ).toEqual({ model: "local/reasoning" });
  });

  it("distinguishes an unsupported Pi thinking override from the provider default", () => {
    expect(
      resolvePiThinkingSetting({ model: "local/plain", thinkingLevel: "max" }, piModels),
    ).toMatchObject({ selected: "max", unavailable: true });
    expect(resolvePiThinkingSetting({}, piModels).options.map((option) => option.id)).toEqual([
      "low",
      "max",
    ]);
    expect(
      resolvePiThinkingSetting({ model: "missing/model", thinkingLevel: "max" }, piModels),
    ).toMatchObject({ options: [], selected: "max", unavailable: true });
  });

  it("hides unsupported Pi workload controls without clearing saved policy", () => {
    const pi = providerClients.get(ProviderDriverKind.make("pi"))!;
    expect(deriveProviderSettingsFields(pi, undefined, true).map((field) => field.key)).toContain(
      "workloadProtection",
    );
    const fields = deriveProviderSettingsFields(pi, undefined, false);
    expect(fields.map((field) => field.key)).not.toContain("workloadProtection");
    expect(fields.map((field) => field.key)).not.toContain("workloadMemoryMiB");
    const model = fields.find((field) => field.key === "model")!;
    expect(
      nextProviderConfigWithFieldValue(
        { workloadProtection: "on", workloadMemoryMiB: "3072" },
        model,
        "local/fixture",
      ),
    ).toEqual({ workloadProtection: "on", workloadMemoryMiB: "3072", model: "local/fixture" });
  });

  it("clears an unsupported Pi thinking override without changing the model", () => {
    const pi = providerClients.get(ProviderDriverKind.make("pi"))!;
    const thinking = deriveProviderSettingsFields(pi).find(
      (field) => field.key === "thinkingLevel",
    )!;
    const next = nextProviderConfigWithFieldValue(
      { model: "local/plain", thinkingLevel: "max" },
      thinking,
      "",
    );
    expect(next).toEqual({ model: "local/plain" });
    expect(resolvePiThinkingSetting(next, piModels)).toMatchObject({
      selected: "",
      unavailable: false,
    });
  });
  it("derives visible provider config fields from the client definition schema", () => {
    const codex = providerClients.get(ProviderDriverKind.make("codex"));

    expect(codex).toBeDefined();
    expect(deriveProviderSettingsFields(codex!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "shadowHomePath",
      "launchArgs",
    ]);
  });

  it("sources labels and descriptions from schema annotations", () => {
    const opencode = providerClients.get(ProviderDriverKind.make("opencode"));
    expect(opencode).toBeDefined();

    const serverPassword = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverPassword",
    );

    expect(serverPassword).toMatchObject({
      label: "Server password",
      description: "Stored in plain text on disk.",
      control: "password",
    });
  });

  it("uses a dedicated environment field instead of legacy Cursor CLI settings", () => {
    const cursor = providerClients.get(ProviderDriverKind.make("cursor"));

    expect(cursor).toBeDefined();
    expect(deriveProviderSettingsFields(cursor!)).toEqual([]);
    expect(cursor?.environmentFields).toEqual([
      {
        name: "CURSOR_API_KEY",
        label: "Cursor API key",
        description: "Optional. Overrides browser sign-in for this provider.",
        placeholder: "Paste API key",
        sensitive: true,
      },
    ]);
  });

  it("exposes ACP Registry as an instance-only configurable driver", () => {
    const acpRegistry = providerClients.get(ProviderDriverKind.make("acpRegistry"));

    expect(acpRegistry).toBeDefined();
    expect(acpRegistry?.hasDefaultInstance).toBe(false);
    expect(deriveProviderSettingsFields(acpRegistry!).map((field) => field.key)).toEqual([
      "source",
      "agentId",
      "commandPath",
      "authMethodId",
    ]);
  });

  it("shows the local executable without registry identity or authentication fields", () => {
    const acpRegistry = providerClients.get(ProviderDriverKind.make("acpRegistry"));
    expect(
      deriveProviderSettingsFields(acpRegistry!, { source: "local" }).map((field) => field.key),
    ).toEqual(["source", "commandPath"]);
  });

  it("derives a select control with its choices for the Antigravity sign-in method", () => {
    const antigravity = providerClients.get(ProviderDriverKind.make("antigravity"));
    expect(antigravity).toBeDefined();

    const fields = deriveProviderSettingsFields(antigravity!);
    expect(fields.map((field) => field.key)).toEqual([
      "authMethod",
      "apiKey",
      "gcpProject",
      "gcpLocation",
      "binaryPath",
    ]);
    const authMethod = fields.find((field) => field.key === "authMethod");
    expect(authMethod).toMatchObject({ control: "select", clearWhenEmpty: "omit" });
    expect(authMethod?.options?.map((option) => option.value)).toEqual([
      "oauth-personal",
      "oauth-business",
      "gemini-api-key",
      "agent-platform",
    ]);
    expect(fields.find((field) => field.key === "apiKey")?.control).toBe("password");
  });

  it("shows the auto-compaction threshold for Claude providers", () => {
    const claude = providerClients.get(ProviderDriverKind.make("claudeAgent"));
    expect(claude).toBeDefined();

    expect(deriveProviderSettingsFields(claude!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "autoCompactWindow",
      "launchArgs",
    ]);
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const opencode = providerClients.get(ProviderDriverKind.make("opencode"));
    expect(opencode).toBeDefined();

    const serverUrl = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverUrl",
    );
    expect(serverUrl).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, serverUrl: "http://127.0.0.1:4096" },
      serverUrl!,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits false boolean fields when clearWhenEmpty is omit", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: true },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: false,
      },
      false,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits true boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: false },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      true,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("preserves false boolean fields when clearWhenEmpty is persist", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "persist",
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });
});
