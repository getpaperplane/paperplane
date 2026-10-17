// @effect-diagnostics nodeBuiltinImport:off -- Vitest fixture lifecycle owns these filesystem resources.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll } from "vite-plus/test";

/** Build an immutable seed once per file; every test gets its own objects, refs and index. */
export function gitRepositoryFixture(input: {
  readonly files: Readonly<Record<string, string>>;
  readonly user: { readonly name: string; readonly email: string };
  readonly message: string;
}) {
  let seed: string;
  beforeAll(() => {
    seed = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-git-seed-"));
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, { cwd: seed, stdio: "pipe" });
    git("init", "--initial-branch=main");
    git("config", "user.email", input.user.email);
    git("config", "user.name", input.user.name);
    git("config", "core.autocrlf", "false");
    for (const [path, contents] of Object.entries(input.files)) {
      const target = NodePath.join(seed, path);
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      NodeFS.writeFileSync(target, contents);
    }
    git("add", ".");
    git("commit", "-m", input.message);
  });
  afterAll(() => {
    if (seed) NodeFS.rmSync(seed, { recursive: true, force: true });
  });
  return (cwd: string) => NodeFS.cpSync(seed, cwd, { recursive: true });
}
