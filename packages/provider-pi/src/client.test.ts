import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { piClient } from "./client.ts";

const decodeSettings = Schema.decodeUnknownSync(piClient.settingsSchema);

describe("Pi SDK client settings", () => {
  it("preserves the SDK configuration used by the server, including instance isolation", () => {
    const settings = decodeSettings({
      enabled: true,
      model: "fixture/model",
      thinkingLevel: "high",
      agentDir: "/isolated/pi-agent",
      workloadProtection: "off",
      workloadMemoryMiB: "512",
      disabledExtensions: ["/extensions/unwanted.ts"],
      customModels: ["fixture/model"],
      binaryPath: "/unused/pi",
      launchArgs: "--mode rpc",
    });
    expect(settings).toEqual({
      enabled: true,
      model: "fixture/model",
      thinkingLevel: "high",
      agentDir: "/isolated/pi-agent",
      workloadProtection: "off",
      workloadMemoryMiB: "512",
      disabledExtensions: ["/extensions/unwanted.ts"],
      customModels: ["fixture/model"],
    });
  });

  it("supplies SDK defaults rather than a CLI launch configuration", () => {
    expect(decodeSettings({})).toMatchObject({
      agentDir: "",
      thinkingLevel: null,
      workloadProtection: "auto",
      disabledExtensions: [],
      customModels: [],
    });
  });
});
