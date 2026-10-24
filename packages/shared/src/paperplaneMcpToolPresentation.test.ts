import { describe, expect, it } from "vite-plus/test";

import {
  PAPERPLANE_MCP_TOOL_NAMES,
  resolvePaperplaneMcpToolPresentation,
} from "./paperplaneMcpToolPresentation.ts";

describe("resolvePaperplaneMcpToolPresentation", () => {
  it("recognizes every Paperplane tool across provider prefixes and completion suffixes", () => {
    for (const tool of PAPERPLANE_MCP_TOOL_NAMES) {
      const presentation = resolvePaperplaneMcpToolPresentation(tool);
      for (const prefix of [
        "mcp__paperplane__",
        "paperplane_",
        "paperplane___",
        "paperplane-",
        "paperplane.",
        "paperplane/",
        "paperplane:",
        "mcp_paperplane_",
        "Paperplane ",
        "paperplane · ",
      ]) {
        expect(resolvePaperplaneMcpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolvePaperplaneMcpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });
  it("pretty prints Claude and Cursor Paperplane MCP tool names", () => {
    expect(resolvePaperplaneMcpToolPresentation("mcp__paperplane__paperplane_thread_read")).toEqual(
      {
        displayName: "Read a Paperplane thread",
        logo: "paperplane",
      },
    );
  });

  it("pretty prints Codex Paperplane MCP tool names", () => {
    expect(resolvePaperplaneMcpToolPresentation("paperplane.create_threads")).toEqual({
      displayName: "Create Paperplane threads",
      logo: "paperplane",
    });
  });

  it("pretty prints thread metadata updates", () => {
    expect(
      resolvePaperplaneMcpToolPresentation("mcp__paperplane__paperplane_thread_update"),
    ).toEqual({
      displayName: "Update Paperplane thread metadata",
      logo: "paperplane",
    });
  });

  it("pretty prints bare Paperplane MCP toolkit names", () => {
    expect(resolvePaperplaneMcpToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "paperplane",
    });
  });

  it("pretty prints worktree Paperplane MCP tool names", () => {
    expect(
      resolvePaperplaneMcpToolPresentation("mcp__paperplane__paperplane_worktree_handoff"),
    ).toEqual({
      displayName: "Hand off thread to a git worktree",
      logo: "paperplane",
    });
    expect(resolvePaperplaneMcpToolPresentation("paperplane.paperplane_worktree_status")).toEqual({
      displayName: "Get thread worktree status",
      logo: "paperplane",
    });
  });

  it("pretty prints preview Paperplane MCP tool names", () => {
    expect(resolvePaperplaneMcpToolPresentation("paperplane.preview_open")).toEqual({
      displayName: "Open a page in the preview browser",
      logo: "paperplane",
    });
    expect(resolvePaperplaneMcpToolPresentation("mcp__paperplane__preview_status")).toEqual({
      displayName: "Get preview browser status",
      logo: "paperplane",
    });
  });

  it("matches the separator variants ACP registry agents emit", () => {
    for (const name of [
      "mcp_paperplane_delegate_task",
      "paperplane:delegate_task",
      "paperplane/delegate_task",
      "paperplane delegate_task",
      "Paperplane delegate_task",
      "paperplane__delegate_task",
    ]) {
      expect(resolvePaperplaneMcpToolPresentation(name)?.displayName).toBe("Delegate a child task");
    }
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolvePaperplaneMcpToolPresentation("paperplane-thread_opencode2-adapter_delegate_task")
        ?.displayName,
    ).toBe("Delegate a child task");
    expect(
      resolvePaperplaneMcpToolPresentation("paperplane-thread_opencode2-adapter_not_a_tool"),
    ).toBeNull();
  });

  it("does not recognize removed server or tool aliases", () => {
    for (const name of [
      "mcp__rove__delegate_task",
      "mcp__rove-code__delegate_task",
      "mcp__rove_code__delegate_task",
      "rove.delegate_task",
      "rove-code_delegate_task",
      "rove_code/delegate_task",
      "rove-thread_old_delegate_task",
      "rove_thread_read",
      "mcp__paperplane__rove_thread_read",
      "paperplane_thread_start",
    ]) {
      expect(resolvePaperplaneMcpToolPresentation(name), name).toBeNull();
    }
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolvePaperplaneMcpToolPresentation("mcp__github__search_issues")).toBeNull();
    expect(resolvePaperplaneMcpToolPresentation("paperplane.not_a_real_tool")).toBeNull();
  });
});
