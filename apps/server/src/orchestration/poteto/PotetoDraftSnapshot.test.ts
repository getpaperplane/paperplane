// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { runPotetoCommand } from "./PotetoProjectRunner.ts";
import { draftPotetoProject, selectPotetoDraftSnapshot } from "./PotetoDraftSnapshot.ts";
import { validatePotetoDraft } from "../../provider/Layers/PiPotetoDraft.ts";

const spec = {
  task: "Fix inclusive boundary",
  editableFiles: ["price.ts"],
  contextFiles: [],
  check: { module: "price.ts", export: "price", cases: [{ args: [100], expected: 10 }] },
};
describe("restricted Poteto drafting snapshot", () => {
  let cwd: string;
  const signal = new AbortController().signal;
  const git = async (...args: string[]) => {
    const result = await runPotetoCommand("git", args, { cwd });
    expect(result.code, result.stderr).toBe(0);
  };
  beforeEach(async () => {
    cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "rove-draft-test-"));
    await git("init", "-q");
    await NodeFSP.writeFile(
      NodePath.join(cwd, "price.ts"),
      "export const price = x => x > 100 ? 10 : 0;",
    );
    await git("add", ".");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    );
  });
  afterEach(async () => {
    await NodeFSP.rm(cwd, { recursive: true, force: true });
  });

  it("ignores dirty, untracked and symlink source while reading the committed version", async () => {
    await NodeFSP.writeFile(NodePath.join(cwd, "price.ts"), "DIRTY");
    await NodeFSP.writeFile(NodePath.join(cwd, "secret.ts"), "UNTRACKED");
    await NodeFSP.symlink("price.ts", NodePath.join(cwd, "link.ts"));
    await git("add", "link.ts");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "link",
    );
    const files = await selectPotetoDraftSnapshot(cwd, "Fix price.ts", signal);
    expect(files).toEqual([
      { path: "price.ts", content: "export const price = x => x > 100 ? 10 : 0;" },
    ]);
  });

  it("uses repository-relative scope when the project is a monorepo package", async () => {
    const packageRoot = NodePath.join(cwd, "apps", "server");
    await NodeFSP.mkdir(packageRoot, { recursive: true });
    const files = await selectPotetoDraftSnapshot(packageRoot, "Fix price.ts", signal);
    expect(files).toEqual([
      { path: "price.ts", content: "export const price = x => x > 100 ? 10 : 0;" },
    ]);
  });

  it("refuses ambiguous large context before calling any model, but accepts explicit paths", async () => {
    for (let i = 0; i < 17; i++)
      await NodeFSP.writeFile(NodePath.join(cwd, `source${i}.ts`), "export const boundary = 1;");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "many",
    );
    const draft = vi.fn();
    const result = await draftPotetoProject({
      workspace: cwd,
      description: "Fix boundary",
      model: "fixture",
      signal,
      draft,
    });
    expect(result.status).toBe("unsupported");
    expect(draft).not.toHaveBeenCalled();
    expect(await selectPotetoDraftSnapshot(cwd, "Fix price.ts", signal)).toHaveLength(1);
    // A broad content term occurs in every module, but a plain module name still selects well.
    expect(await selectPotetoDraftSnapshot(cwd, "Price boundary is broken", signal)).toEqual([
      { path: "price.ts", content: "export const price = x => x > 100 ? 10 : 0;" },
    ]);
  });

  it("validates references and specification, and removes neutral directories without workspace writes", async () => {
    let neutral = "";
    const result = await draftPotetoProject({
      workspace: cwd,
      description: "Fix price.ts",
      model: "fixture",
      signal,
      draft: async (options, request) => {
        neutral = options.cwd;
        expect(options.cwd).not.toBe(cwd);
        expect(request.files[0]?.content).toContain("x > 100");
        return { status: "draft", spec };
      },
    });
    expect(result).toEqual({ status: "draft", spec });
    await expect(NodeFSP.stat(neutral)).rejects.toThrow();
    expect(
      (await runPotetoCommand("git", ["status", "--porcelain"], { cwd })).stdout.toString(),
    ).toBe("");
    expect(() =>
      validatePotetoDraft(
        {
          status: "draft",
          spec: {
            ...spec,
            editableFiles: ["missing.ts"],
            check: { ...spec.check, module: "missing.ts" },
          },
        },
        [{ path: "price.ts", content: "" }],
      ),
    ).toThrow("outside");
    expect(() =>
      validatePotetoDraft(
        { status: "draft", spec: { ...spec, editableFiles: ["../price.ts"] } },
        [],
      ),
    ).toThrow();
    expect(() =>
      validatePotetoDraft(
        { status: "draft", spec: { ...spec, check: { ...spec.check, cases: [] } } },
        [],
      ),
    ).toThrow();
  });
});
