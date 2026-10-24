/**
 * Thin CLI entry.
 *
 * Every ACP agent spawns `paperplane acp-mcp-bridge` while opening its session, and
 * terminal-fallback agents run `paperplane acp-mcp-call` per tool call, so their
 * startup sits on first-message latency. Both dispatch here before the full
 * CLI module graph (seconds of evaluation) loads; everything else defers to
 * the real CLI in ./binCli.ts.
 */
import { isEntrypoint } from "./entrypoint.ts";
import { piCliInvocation } from "./cli/piCli.ts";
import { requireCliExternal } from "./cli/requireExternal.ts";

const piCli = piCliInvocation(process.argv, process.env);
if (piCli) {
  // Pi extensions relaunch the embedded SDK worker as `pi`.
  process.argv.splice(1, 2, piCli.entry);
  requireCliExternal(piCli.entry);
} else if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  const command = process.argv[2];
  if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
    const { runAcpMcpCliFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpCliFastPath(command, process.argv.slice(3));
  } else {
    const { runCli } = await import("./binCli.ts");
    runCli();
  }
}
