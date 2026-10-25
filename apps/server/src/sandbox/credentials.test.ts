// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { makeLocalSandboxCredentials } from "./credentials.ts";

function home() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "paperplane-sandbox-credentials-"));
  NodeFS.mkdirSync(NodePath.join(dir, ".codex"));
  NodeFS.writeFileSync(NodePath.join(dir, ".codex", "auth.json"), '{"tokens":"codex-login"}');
  return dir;
}

it("forwards only selected sign-ins and removes the rest", async () => {
  const source = makeLocalSandboxCredentials({
    env: { GH_TOKEN: "gho_token" },
    home: home(),
    platform: "linux",
  });
  const available = await source.available();
  expect(available).toEqual(expect.arrayContaining(["codex", "github"]));
  expect(available).not.toContain("pi");

  const payload = await source.payload(["codex", "github"]);
  expect(payload.files).toEqual([
    { path: ".codex/auth.json", content: '{"tokens":"codex-login"}' },
    expect.objectContaining({ path: ".config/gh/hosts.yml" }),
  ]);
  expect(payload.files[1]!.content).toContain("oauth_token: gho_token");
  expect(payload.tools.map((tool) => tool.bin)).toEqual(["codex", "gh"]);
  expect(payload.remove).toEqual([
    ".claude/.credentials.json",
    ".pi/agent/auth.json",
    ".local/share/opencode/auth.json",
  ]);
});

it("refuses to forward a sign-in the managing environment doesn't have", async () => {
  const source = makeLocalSandboxCredentials({ env: {}, home: home(), platform: "linux" });
  await expect(source.payload(["pi"])).rejects.toThrow("Pi isn't signed in");
});
