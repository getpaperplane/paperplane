import { ProviderDriverKind } from "@rove-code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyProviderInstanceDraft,
  draftFromProviderInstance,
  providerDraftChanged,
  listProviderInstanceRows,
  providerInstanceEnabledMutation,
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
