import { describe, expect, it } from "vite-plus/test";
import { warnIgnoredLegacyEnvironment } from "./legacyEnvironment.ts";

describe("ignored legacy environment warnings", () => {
  it("names each replacement once, including empty and shadowed old settings", () => {
    const env = {
      ROVE_HOME: "/old-home",
      ROVE_PORT: "",
      PAPERPLANE_PORT: "4000",
      ROVE_OTLP_HEADERS: "authorization=private-token",
      ROVE_DISABLE_AUTO_UPDATE: "true",
      ROVE_INSTALL_BIN_DIR: "/old-bin",
    };
    const before = { ...env };
    const warnings: string[] = [];
    warnIgnoredLegacyEnvironment(env, (message) => warnings.push(message));
    expect(warnings).toEqual([
      "ROVE_HOME is set but ignored; use PAPERPLANE_HOME.",
      "ROVE_PORT is set but ignored; use PAPERPLANE_PORT.",
      "ROVE_DISABLE_AUTO_UPDATE is set but ignored; use PAPERPLANE_DISABLE_AUTO_UPDATE.",
      "ROVE_INSTALL_BIN_DIR is set but ignored; use PAPERPLANE_INSTALL_BIN_DIR.",
      "ROVE_OTLP_HEADERS is set but ignored; use PAPERPLANE_OTLP_HEADERS.",
    ]);
    expect(env).toEqual(before);
  });

  it("stays silent for new, unset, internal, build, release, and test variables", () => {
    const warnings: string[] = [];
    warnIgnoredLegacyEnvironment(
      {
        PAPERPLANE_HOME: "/new-home",
        ROVE_HOME: undefined,
        ROVE_BOOT_SERVICE_UNIT: "rove.service",
        ROVE_BOOTSTRAP_FD: "3",
        ROVE_ACP_MCP_ENDPOINT: "http://localhost:1234",
        ROVE_CLOUD_READY: "1",
        ROVE_PACK_EXE: "1",
        ROVE_ACP_FAIL_PROMPT: "1",
      },
      (message) => warnings.push(message),
    );
    expect(warnings).toEqual([]);
  });
});
