import { ProviderDriverKind } from "@getpaperplane/contracts";
import {
  nextProviderEnvironmentWithFieldValue,
  type ProviderSettingsFieldModel,
} from "@getpaperplane/client-runtime/state/provider-instance-settings";
import { describe, expect, it } from "vite-plus/test";

import {
  applyProviderInstanceDraft,
  draftFromProviderInstance,
  providerDraftChanged,
  listProviderInstanceRows,
  providerInstanceEnabledMutation,
  providerInstanceCreateMutation,
  providerInstanceSaveMutation,
  nextProviderDraftConfigWithFieldValue,
} from "./provider-instances";

const codex = ProviderDriverKind.make("codex");
const acp = ProviderDriverKind.make("acpRegistry");

describe("listProviderInstanceRows", () => {
  it("lists default slots, skips drivers without one, and keeps custom instances", () => {
    const rows = listProviderInstanceRows(
      { providerInstances: { codex_work: { driver: codex } } as never },
      [{ driverKind: codex }, { driverKind: acp, hasDefaultInstance: false }],
    );
    expect(rows.map((row) => [row.instanceId, row.isDefault, row.configured])).toEqual([
      ["codex", true, false],
      ["codex_work", false, true],
    ]);
  });
});

describe("provider instance mutations", () => {
  it("creates an enabled managed Codex account and can switch setup without dropping secrets", () => {
    const secret = { name: "TOKEN", value: "", sensitive: true, valueRedacted: true };
    const draft = {
      displayName: "Work",
      config: { setupMode: "managed", apiKey: "REDACTED" },
      environment: [secret],
    };
    const create = providerInstanceCreateMutation({
      driver: codex,
      instanceId: "codex_work",
      draft,
    });
    expect(create).toMatchObject({
      operation: "create",
      instance: { enabled: true, config: { setupMode: "managed" }, environment: [secret] },
    });
    const saved = applyProviderInstanceDraft(
      { driver: codex, enabled: true, config: draft.config, environment: draft.environment },
      { ...draft, config: { ...draft.config, setupMode: "existing" } },
    );
    expect(saved).toMatchObject({
      enabled: true,
      config: { setupMode: "existing", apiKey: "REDACTED" },
      environment: [secret],
    });
  });
  it("preserves credentials and other fields when toggling", () => {
    const row = {
      instanceId: "codex_work" as never,
      instance: { driver: codex, accentColor: "#fff", config: { apiKey: "REDACTED" } },
    };
    expect(providerInstanceEnabledMutation(row, false)).toEqual({
      operation: "upsert",
      instanceId: "codex_work",
      instance: {
        driver: codex,
        accentColor: "#fff",
        config: { apiKey: "REDACTED" },
        enabled: false,
      },
    });
  });

  it("drops a blank name and empty config from a draft", () => {
    expect(
      applyProviderInstanceDraft(
        { driver: codex, displayName: "Old", config: { a: 1 } },
        {
          displayName: " ",
          config: undefined,
          environment: [{ name: "", value: "", sensitive: true }],
        },
      ),
    ).toEqual({ driver: codex });
  });
});

describe("secret replacement cancellation", () => {
  const replacement = "test-only-replacement";

  it.each(["omit", "persist"] as const)(
    "restores a saved secret after typing then erasing (%s)",
    (clearWhenEmpty) => {
      const field: ProviderSettingsFieldModel = {
        key: "apiKey",
        label: "API key",
        control: "password",
        secret: true,
        clearWhenEmpty,
      };
      const row = {
        instanceId: "codex_work" as never,
        instance: { driver: codex, config: { apiKey: "REDACTED", hidden: true } },
      };
      const initial = draftFromProviderInstance(row.instance);
      const typed = nextProviderDraftConfigWithFieldValue(
        initial.config,
        initial.config,
        field,
        replacement,
      );
      expect(typed?.apiKey).toBe(replacement);
      const config = nextProviderDraftConfigWithFieldValue(
        { ...typed, otherEdit: "kept" },
        initial.config,
        field,
        "",
      );
      const serialized = JSON.stringify(providerInstanceSaveMutation(row, { ...initial, config }));
      expect(serialized).not.toContain(replacement);
      expect(JSON.parse(serialized)).toMatchObject({
        operation: "upsert",
        instance: { config: { apiKey: "REDACTED", hidden: true, otherEdit: "kept" } },
      });
      expect(row.instance.config.apiKey).toBe("REDACTED");
    },
  );

  it.each(["omit", "persist"] as const)(
    "omits a new secret after typing then erasing (%s)",
    (clearWhenEmpty) => {
      const field: ProviderSettingsFieldModel = {
        key: "apiKey",
        label: "API key",
        control: "password",
        secret: true,
        clearWhenEmpty,
      };
      const initial = draftFromProviderInstance({ driver: codex });
      const typed = nextProviderDraftConfigWithFieldValue(
        initial.config,
        initial.config,
        field,
        replacement,
      );
      expect(typed?.apiKey).toBe(replacement);
      const config = nextProviderDraftConfigWithFieldValue(typed, initial.config, field, "");
      const serialized = JSON.stringify(
        providerInstanceCreateMutation({
          driver: codex,
          instanceId: "codex_work",
          draft: { ...initial, config },
        }),
      );
      expect(serialized).not.toContain(replacement);
      expect(JSON.parse(serialized)).toEqual({
        operation: "create",
        instanceId: "codex_work",
        instance: { driver: codex, enabled: true },
      });
    },
  );

  it("does not retain a cleared driver environment replacement", () => {
    const row = {
      instanceId: "codex_work" as never,
      instance: {
        driver: codex,
        environment: [{ name: "TOKEN", value: "", sensitive: true, valueRedacted: true }],
      },
    };
    const initial = draftFromProviderInstance(row.instance);
    const field = { name: "TOKEN", sensitive: true };
    const typed = nextProviderEnvironmentWithFieldValue(initial.environment, field, replacement);
    expect(typed[0]?.value).toBe(replacement);
    const environment = nextProviderEnvironmentWithFieldValue(typed, field, "");
    const serialized = JSON.stringify(
      providerInstanceSaveMutation(row, { ...initial, environment }),
    );
    expect(serialized).not.toContain(replacement);
    expect(JSON.parse(serialized)).toEqual({
      operation: "upsert",
      instanceId: "codex_work",
      instance: { driver: codex },
    });
  });
});

describe("provider draft round trip", () => {
  const instance = {
    driver: acp,
    displayName: "Agent",
    config: { source: "local", commandPath: "dsh", commandArgs: ["-x"], customModels: ["m"] },
    environment: [{ name: "TOKEN", value: "", sensitive: true, valueRedacted: true }],
  };

  it("preserves hidden config and redacted secrets on an unchanged save", () => {
    expect(applyProviderInstanceDraft(instance, draftFromProviderInstance(instance))).toEqual(
      instance,
    );
  });

  it("is dirty only for real edits, not an added blank variable", () => {
    const initial = draftFromProviderInstance(instance);
    const blank = {
      ...initial,
      environment: [...initial.environment, { name: "", value: "", sensitive: true }],
    };
    expect(providerDraftChanged(initial, blank)).toBe(false);
    expect(providerDraftChanged(initial, { ...initial, displayName: "Other" })).toBe(true);
  });
});
