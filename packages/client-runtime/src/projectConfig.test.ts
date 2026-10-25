import { describe, expect, it } from "vite-plus/test";
import { resolveProjectConfigState } from "./projectConfig.ts";

describe("project configuration presentation", () => {
  it("shows the rename instruction and supplies no defaults or scripts for a legacy-only checkout", () => {
    const state = resolveProjectConfigState({ status: "legacy-only" });
    expect(state.file).toBeNull();
    expect(state.scripts).toEqual([]);
    expect(state.notice).toContain("Rename rove.json to paperplane.json");
  });

  it("clears the rename notice and exposes the server-accepted file after renaming", () => {
    const file = {
      defaultThreadEnvMode: "worktree" as const,
      scripts: [{ name: "Test", command: "vp test" }],
    };
    const state = resolveProjectConfigState({ status: "valid", file });
    expect(state.file).toEqual(file);
    expect(state.scripts).toEqual(file.scripts);
    expect(state.notice).toBeNull();
  });

  it("does not hide cached accepted configuration during a refresh", () => {
    const state = resolveProjectConfigState({ status: "valid", file: {} }, true);
    expect(state.status).toBe("valid");
    expect(state.notice).toBeNull();
    expect(resolveProjectConfigState(null, true).status).toBe("loading");
  });

  it("distinguishes an invalid current file from a missing file", () => {
    expect(resolveProjectConfigState({ status: "invalid" }).notice).toContain(
      "paperplane.json is invalid",
    );
    expect(resolveProjectConfigState({ status: "invalid" }).scripts).toEqual([]);
    expect(resolveProjectConfigState({ status: "missing" }).notice).toBeNull();
  });
});
