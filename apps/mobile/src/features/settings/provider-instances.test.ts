import { ProviderDriverKind } from "@rove-code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyProviderInstanceDraft,
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
        { displayName: " ", config: undefined },
      ),
    ).toEqual({ driver: codex });
  });
});
