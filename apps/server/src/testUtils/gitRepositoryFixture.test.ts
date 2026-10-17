// @effect-diagnostics nodeBuiltinImport:off -- Exercises independent on-disk Git fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { gitRepositoryFixture } from "./gitRepositoryFixture.ts";

const copyRepository = gitRepositoryFixture({
  files: { "README.md": "initial\n" },
  user: { name: "Test", email: "test@example.com" },
  message: "initial",
});

it("does not share the index, refs, objects or working files between copies", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-git-copy-test-"));
  const first = NodePath.join(root, "first");
  const second = NodePath.join(root, "second");
  const git = (cwd: string, ...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    copyRepository(first);
    copyRepository(second);
    const original = git(second, "rev-parse", "HEAD");
    NodeFS.writeFileSync(NodePath.join(first, "README.md"), "changed\n");
    git(first, "checkout", "-b", "changed");
    git(first, "add", ".");
    git(first, "commit", "-m", "changed");
    const newObject = git(first, "rev-parse", "HEAD");
    expect(git(second, "rev-parse", "HEAD")).toBe(original);
    expect(git(second, "branch", "--list", "changed")).toBe("");
    expect(git(second, "status", "--porcelain")).toBe("");
    expect(NodeFS.readFileSync(NodePath.join(second, "README.md"), "utf8")).toBe("initial\n");
    expect(() => git(second, "cat-file", "-e", newObject)).toThrow();
    copyRepository(NodePath.join(root, "third"));
    expect(git(NodePath.join(root, "third"), "rev-parse", "HEAD")).toBe(original);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
