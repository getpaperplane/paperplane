/** Paperplane's app-owned MCP server identity, independent of the product/package name. */
export const PAPERPLANE_MCP_SERVER_NAME = "paperplane";
export const PAPERPLANE_MCP_TOOL_PREFIX = `mcp__${PAPERPLANE_MCP_SERVER_NAME}__`;

/**
 * pi-claude-code caps Pi tool names at 50 characters because it re-exposes them to Claude Code
 * as `mcp__pi__<name>` under Claude's 64-character limit. Names that already fit are unchanged;
 * longer ones drop the redundant `paperplane_` tool prefix, then fall back to a truncated name
 * with a stable FNV-1a hash suffix.
 */
const PI_TOOL_NAME_MAX_LENGTH = 50;

export function piPaperplaneToolName(tool: string): string {
  const full = `${PAPERPLANE_MCP_TOOL_PREFIX}${tool}`;
  if (full.length <= PI_TOOL_NAME_MAX_LENGTH) return full;
  const short = `${PAPERPLANE_MCP_TOOL_PREFIX}${tool.replace(/^paperplane_/, "")}`;
  if (short.length <= PI_TOOL_NAME_MAX_LENGTH) return short;
  let hash = 0x811c9dc5;
  for (let i = 0; i < tool.length; i++) {
    hash = Math.imul(hash ^ tool.charCodeAt(i), 0x01000193) >>> 0;
  }
  const suffix = `_${hash.toString(16).padStart(8, "0")}`;
  return `${full.slice(0, PI_TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
}
