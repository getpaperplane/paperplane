# Pi delegates through Paperplane MCP

Supersedes [ADR 0003](0003-pi-subagents-are-rove-owned.md).

## Decision

Pi threads delegate through Paperplane's app-owned V2 delegation tools, including
MCP `delegate_task`. The thread's MCP session exposes these tools to Pi through
`PiPaperplaneTools`. Paperplane no longer injects a Pi-specific SDK subagent tool.

V2 owns child threads, task state, cancellation, and completion delivery across
providers. Keeping a second Pi-only lifecycle would duplicate that ownership
and leave children without the durable thread controls available to MCP tasks.
Pi therefore reports no provider-native subagent capabilities. Those flags do
not restrict app-owned MCP delegation.

## Consequences

Pi's subagent enable, model, and thinking settings are removed. Delegated tasks
select their provider and model through Paperplane's tools. Existing transcript files
under `<stateDir>/agent-transcripts` remain on disk.

Third-party extension tools continue to run under their own contracts. Paperplane
does not infer delegated tasks from extension output or subprocesses.
