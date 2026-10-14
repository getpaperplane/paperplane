import { describe, expect, it } from "vite-plus/test";
import { resolvePotetoDraftWorkspace } from "./poteto.ts";

describe("Poteto draft workspace", () => {
  it("rejects a not-yet-created worktree instead of silently using the project root", () => {
    expect(
      resolvePotetoDraftWorkspace({
        workspaceMode: "worktree",
        branch: "main",
        currentBranch: "main",
        worktreePath: null,
      }).valid,
    ).toBe(false);
  });
  it("rejects a branch selection that still needs checkout", () => {
    expect(
      resolvePotetoDraftWorkspace({
        workspaceMode: "local",
        branch: "feature",
        currentBranch: "main",
        worktreePath: null,
      }).valid,
    ).toBe(false);
  });
  it("records the current checkout when no branch was explicitly selected", () => {
    expect(
      resolvePotetoDraftWorkspace({
        workspaceMode: "local",
        branch: null,
        currentBranch: "main",
        worktreePath: null,
      }),
    ).toEqual({ valid: true, branch: "main", worktreePath: null });
  });
  it("accepts a worktree that already exists instead of treating it as a new one", () => {
    expect(
      resolvePotetoDraftWorkspace({
        workspaceMode: "worktree",
        branch: "feature",
        currentBranch: "main",
        worktreePath: "/repo/worktree",
      }),
    ).toEqual({ valid: true, branch: "feature", worktreePath: "/repo/worktree" });
  });
  it("preserves an existing worktree and its branch rather than the root checkout", () => {
    expect(
      resolvePotetoDraftWorkspace({
        workspaceMode: "local",
        branch: "feature",
        currentBranch: "main",
        worktreePath: "/repo/worktree",
      }),
    ).toEqual({ valid: true, branch: "feature", worktreePath: "/repo/worktree" });
  });
});
