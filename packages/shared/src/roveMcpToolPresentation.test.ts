import { describe, expect, it } from "vite-plus/test";

import { ROVE_MCP_TOOL_NAMES, resolveRoveMcpToolPresentation } from "./roveMcpToolPresentation.ts";

describe("resolveRoveMcpToolPresentation", () => {
  it("recognizes every Paperplane tool across provider prefixes and completion suffixes", () => {
    for (const tool of ROVE_MCP_TOOL_NAMES) {
      const presentation = resolveRoveMcpToolPresentation(tool);
      for (const prefix of [
        "mcp__rove-code__",
        "mcp__rove_code__",
        "mcp__rove__",
        "rove_",
        "rove___",
        "rove-",
        "Rove-code.",
        "rove_code/",
        "rove:",
        "mcp_rove-code_",
        "Rove Code ",
        "rove · ",
      ]) {
        expect(resolveRoveMcpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveRoveMcpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });
  it("pretty prints Claude and Cursor Paperplane MCP tool names", () => {
    expect(resolveRoveMcpToolPresentation("mcp__rove__rove_thread_read")).toEqual({
      displayName: "Read a Paperplane thread",
      logo: "rove",
    });
  });

  it("pretty prints Codex Paperplane MCP tool names", () => {
    expect(resolveRoveMcpToolPresentation("rove.create_threads")).toEqual({
      displayName: "Create Paperplane threads",
      logo: "rove",
    });
  });

  it("pretty prints thread metadata updates", () => {
    expect(resolveRoveMcpToolPresentation("mcp__rove__rove_thread_update")).toEqual({
      displayName: "Update Paperplane thread metadata",
      logo: "rove",
    });
  });

  it("pretty prints bare Paperplane MCP toolkit names", () => {
    expect(resolveRoveMcpToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "rove",
    });
  });

  it("pretty prints worktree Paperplane MCP tool names", () => {
    expect(resolveRoveMcpToolPresentation("mcp__rove__rove_worktree_handoff")).toEqual({
      displayName: "Hand off thread to a git worktree",
      logo: "rove",
    });
    expect(resolveRoveMcpToolPresentation("rove.rove_worktree_status")).toEqual({
      displayName: "Get thread worktree status",
      logo: "rove",
    });
  });

  it("pretty prints preview Paperplane MCP tool names", () => {
    expect(resolveRoveMcpToolPresentation("Rove-code.preview_open")).toEqual({
      displayName: "Open a page in the preview browser",
      logo: "rove",
    });
    expect(resolveRoveMcpToolPresentation("mcp__rove__preview_status")).toEqual({
      displayName: "Get preview browser status",
      logo: "rove",
    });
  });

  it("matches the separator variants ACP registry agents emit", () => {
    for (const name of [
      "mcp_rove-code_delegate_task",
      "rove_code:delegate_task",
      "rove/delegate_task",
      "rove delegate_task",
      "Rove Code delegate_task",
      "rove-code__delegate_task",
    ]) {
      expect(resolveRoveMcpToolPresentation(name)?.displayName).toBe("Delegate a child task");
    }
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveRoveMcpToolPresentation("rove-thread_opencode2-adapter_delegate_task")?.displayName,
    ).toBe("Delegate a child task");
    expect(resolveRoveMcpToolPresentation("rove-thread_opencode2-adapter_not_a_tool")).toBeNull();
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveRoveMcpToolPresentation("mcp__github__search_issues")).toBeNull();
    expect(resolveRoveMcpToolPresentation("rove.not_a_real_tool")).toBeNull();
  });
});
