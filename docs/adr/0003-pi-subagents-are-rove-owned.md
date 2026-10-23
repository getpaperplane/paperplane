# Pi subagents are Paperplane-owned sessions, not observed processes

Status: superseded by [ADR 0004](0004-pi-delegates-through-rove-mcp.md).

Supersedes [ADR 0002](0002-pi-subagent-observation.md).

ADR 0002 inferred subagents from what extensions do: it injected a hook into
every process a tool started, patched Pi SDK agents, and recognized agent CLIs
by name. That inference was the wrong boundary. An agent running beneath a tool
call is not necessarily delegated work: a test suite run through `bash`
constructs Pi agents, a dev server starts `codex app-server`, and both appeared
as subagents. Each fix added an exclusion, and every new extension or tool
shape could need another. Meanwhile extensions that delegate in ways the hook
could not see still showed nothing.

## Decision

Paperplane gave Pi threads a dedicated SDK subagent tool, much as it owned extension
dialogs instead of emulating a terminal. Each call creates a fresh SDK session
in the Pi runtime worker:

- No extensions, so it cannot delegate again and extension hooks never run twice.
- Pi's standard tools (Paperplane's workload-protected shell when enabled) and the
  project's context files.
- The thread's current model and reasoning level, or the instance's
  **Subagent model**.
- An in-memory session; Paperplane writes its own transcript.

Because Paperplane starts the session, Agents rows come from its real lifecycle:
started, progress, completed, failed, or stopped. Stop aborts the tool call,
which aborts the child; disposing the thread session stops any still running.

Paperplane no longer observes processes or agents it did not start. Subagents that
third-party extensions start still run and appear as those extensions' tool
calls. A per-instance setting turns the Paperplane tool off.

## Consequences

- No `NODE_OPTIONS` injection, `child_process` wrapping, SDK prototype patches,
  or CLI name matching. A Pi SDK upgrade can only break subagents through public
  session APIs.
- Extension subagent progress is not in Agents. Supporting one would need that
  extension to report through an explicit contract, which Paperplane does not offer.
- The tool name is prefixed so it never collides with an extension's
  `subagent` tool.
- Transcripts keep the JSONL format and location ADR 0002 introduced, so rows
  recorded by the old observer still open.
