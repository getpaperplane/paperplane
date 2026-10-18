# Features deferred by the orchestration V2 cutover

These Rove features depended on V1 orchestration commands, events, or projections that V2
replaced, so their V1 integrations were removed rather than kept half-working. Recover the
pre-sync implementation at fork commit `cbfe21300f`, for example with
`git show cbfe21300f:<path>`. Each feature should have its own V2 port PR, limited to behavior
not already supplied by V2.

The recovery links below point to that commit, not the current tree. V1's shared
[orchestration contracts](https://github.com/hafiezul/rove/blob/cbfe21300f/packages/contracts/src/orchestration.ts)
and [client commands](https://github.com/hafiezul/rove/blob/cbfe21300f/packages/client-runtime/src/operations/commands.ts)
carry the old wire integration. New ports must use committed V2 commands and outbox effects,
not restore V1 reactors or activity rows. Web changes also cover desktop's embedded client;
mobile has separate entry points.

## Poteto Mode

Pi users could turn a bug description into a proposed, bounded check specification, explicitly
approve it, and run reproduction, investigation, competing designs, implementation, verification,
and independent review. The pilot returned a reviewed candidate patch without modifying the
checkout; it supported small dependency-free JS/TS exports, not arbitrary project test suites.

Origins: [#285](https://github.com/hafiezul/rove/pull/285) (`8f56108cb6`),
[#287](https://github.com/hafiezul/rove/pull/287) (`73347d09d9`), and
[#288](https://github.com/hafiezul/rove/pull/288) (`cbfe21300f`). Recovery anchors are the server
[thread reactor](https://github.com/hafiezul/rove/blob/cbfe21300f/apps/server/src/orchestration/poteto/ThreadPotetoReactor.ts)
and [Pi draft boundary](https://github.com/hafiezul/rove/blob/cbfe21300f/apps/server/src/provider/Layers/PiPotetoDraft.ts),
[spec/progress contract](https://github.com/hafiezul/rove/blob/cbfe21300f/packages/contracts/src/poteto.ts),
[client validation](https://github.com/hafiezul/rove/blob/cbfe21300f/packages/client-runtime/src/poteto.ts),
[web dialog](https://github.com/hafiezul/rove/blob/cbfe21300f/apps/web/src/components/chat/PotetoModeDialog.tsx),
and [mobile form](https://github.com/hafiezul/rove/blob/cbfe21300f/apps/mobile/src/features/threads/PotetoModeForm.tsx).

The cutover removed drafting RPCs, Start/Control/Append/Finish commands, candidate activities and
projections, Pi Poteto worker/IPC plumbing, and pilot scripts. Draft/composer/header/thread-action
and shortcut entry points, status/artifact panels, and their web/mobile consumers were removed;
`potetoMode` and `potetoDraft` capabilities no longer advertise support.

A port needs an explicitly approved draft-to-run service, durable attempt/phase/candidate state
in [V2 projections](../../apps/server/src/orchestration-v2/ProjectionStore.ts), and execution through
[the effect worker](../../apps/server/src/orchestration-v2/EffectWorker.ts). Keep the approved model,
committed HEAD snapshot, editable scope and checks fixed; drafting must remain tool-free. Preserve
network-free container checks, no automatic model-call restart, cleanup before retry, and candidate
artifacts distinct from workspace changes. Add guarded start/control commands and both clients'
proposal and cancellation flows only once that lifecycle exists.

## Continuing threads in another environment

“Continue on” moved work to another connected machine with the same repository: Git carried the
pushed branch and the client carried bounded conversation context, with source/destination links.
It was not native provider-session transfer, and the two servers did not contact each other.

Origins: [#270](https://github.com/hafiezul/rove/pull/270) (`e50f840ada`), with destination branch
checkout from [#243](https://github.com/hafiezul/rove/pull/243) (`41c53c8b79`). Recover the server
[export validation](https://github.com/hafiezul/rove/blob/cbfe21300f/apps/server/src/orchestration/threadHandoff.ts),
[handoff contract](https://github.com/hafiezul/rove/blob/cbfe21300f/packages/contracts/src/threadHandoff.ts),
[client target/link logic](https://github.com/hafiezul/rove/blob/cbfe21300f/packages/client-runtime/src/threadHandoff.ts),
[web continuation hook](https://github.com/hafiezul/rove/blob/cbfe21300f/apps/web/src/hooks/useContinueThreadOnEnvironment.ts),
and [mobile continuation control](https://github.com/hafiezul/rove/blob/cbfe21300f/apps/mobile/src/features/threads/ThreadContinuation.tsx).

Removed across server/contracts/runtime were export and MCP handoff registration, continuation
record activities, bootstrap `handoff`/`expectedCommit`, and `threadContinuationLinks` /
`threadPortableHandoff` capabilities. Web/desktop and mobile lost Continue-on menus, draft handoff
metadata, import/outbox delivery and backlink reconcilers; obsolete mobile metadata is discarded
without discarding draft text. Direct-base-branch checkout draft controls were also removed.
Upstream same-environment provider handoffs and forks remain; they are not a cross-environment port.

Build on [V2 context transfers and lineage](../orchestration-v2/thread-lineage-and-context-transfer.md),
[ContextHandoffServiceV2](../../apps/server/src/orchestration-v2/ContextHandoffService.ts), and
[ThreadLaunchService](../../apps/server/src/orchestration-v2/ThreadLaunchService.ts). Cross-environment
identity and backlinks need an explicit extension: current local thread/run references are not
portable identities. Persist the source point, target workspace and delivery receipt so reconnects
cannot duplicate a continuation. Preserve idle-source checks, repository/remote identity, clean
and pushed branch/commit verification, destination-local `expectedCommit` validation and explicit
code-only fallback. Recheck destination permissions and capabilities at execution; transfer no
credentials, approvals or provider-native state.

## Standalone threads

Users could start a thread without creating a project; the server allocated a per-thread workspace.
This also supplied automatic initial threads for remote sandboxes and standalone sidebar/archive,
terminal and imported-session behavior.

Origin: [#234](https://github.com/hafiezul/rove/pull/234) (`8c9a3c5b87`). Recover the server
[workspace normalization](https://github.com/hafiezul/rove/blob/cbfe21300f/apps/server/src/orchestration/Normalizer.ts),
the shared V1 orchestration contract above,
[client creation helper](https://github.com/hafiezul/rove/blob/cbfe21300f/packages/client-runtime/src/state/standaloneThread.ts),
[web new-thread hook](https://github.com/hafiezul/rove/blob/cbfe21300f/apps/web/src/hooks/useHandleNewThread.ts),
and [mobile creation hook](https://github.com/hafiezul/rove/blob/cbfe21300f/apps/mobile/src/state/use-start-standalone-thread.ts).

The nullable `projectId` / standalone `workspacePath` model, `standaloneThreads` capability,
provider/checkpoint/settlement plumbing, client grouping and path fallbacks, and projectless
creation branches were removed. Sandbox management and pairing remain under `remoteSandboxes`,
but an unlinked sandbox now pairs as an environment without fabricating a thread. The dropped
[V1 migration 56](https://github.com/hafiezul/rove/blob/cbfe21300f/apps/server/src/persistence/Migrations/056_StandaloneThreads.ts)
made `projection_threads.project_id` nullable and added `workspace_path`; it must not be re-registered.

Use [ManagedProjectFolders](../../apps/server/src/project/ManagedProjectFolders.ts)' Scratch project
and [V2 launch](../../apps/server/src/orchestration-v2/ThreadLaunchService.ts) ownership instead of
widening every V2 project reference to null. Upstream already supplies Scratch/“No project” UX;
port only missing Rove semantics, including sandbox initial-thread linkage independent of pairing.
Legacy null/blank-project threads are imported under an existing project matching their workspace
root, or a new project named after the workspace directory. Threads without a usable absolute
`workspace_path` are skipped with a counted warning; their V1 rows remain available for recovery.
This preserves history without restoring nullable V2 ownership. Preserve imported-thread
overwrite/auto-settle protection and route creation through V2 launch receipts, not V1
detail-pending state.

## Usage-limit auto-resume

V2 recovery runs through the persisted-state
[UsageLimitRecoveryWorker](../../apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts)
and the shared scheduler. Extend that lifecycle; do not restore the V1 reactor or its
`projection_threads.limit_recovery_json` column.

Still deferred: native per-instance quota-snapshot enrichment of reset times.

Constraints worth knowing: the three-attempt cap counts only the worker's automatic
continuations (a run's `usageLimitContinuationOfRunId` chain), and applies only to recoveries
the worker armed itself (`automatic`). An explicit user Resume or a manual send is consent and
starts a fresh allowance. Restart continuations inherit the link so a crash cannot reset the
count. Runs without a recorded parent begin a new chain. Missing or implausible reset evidence
(beyond a week, or a time that just passed) classifies a limit but never schedules a retry.

## Rove's rich-response renderer

Assistant replies could contain native tables, expandable details and prompt choices, later extended
to sandboxed interactive HTML pages with embedded local media. Clients rendered structured
`rove-response` fences and supplied readable copy/fallback behavior.

Origins: [#277](https://github.com/hafiezul/rove/pull/277) (`144978036f`) and
[#281](https://github.com/hafiezul/rove/pull/281) (`3014b75399`). Recover the server
[MCP tool](https://github.com/hafiezul/rove/blob/cbfe21300f/apps/server/src/mcp/toolkits/richResponse/tools.ts),
[block contract](https://github.com/hafiezul/rove/blob/cbfe21300f/packages/contracts/src/richResponse.ts),
[shared decoder](https://github.com/hafiezul/rove/blob/cbfe21300f/packages/shared/src/richResponse.ts),
[web renderer](https://github.com/hafiezul/rove/blob/cbfe21300f/apps/web/src/components/chat/RichResponseContent.tsx),
and [mobile renderer](https://github.com/hafiezul/rove/blob/cbfe21300f/apps/mobile/src/features/threads/RichResponseContent.tsx).
There was no feature-specific client-runtime renderer; decoding was in shared code.

Removed were the duplicate MCP registration/provider prompt flag, V1 projection payload support,
contracts/subpath export and decoder, Markdown fence/minimap integration and native renderers on
web/desktop/mobile. The `enableRichResponses` setting/control was removed, not left as a working
opt-out. Upstream's `html_render`, HTML references, themed frames and mobile WebView are used instead.

Any port should add only missing structured-artifact behavior to
[the V2 HTML toolkit](../../apps/server/src/mcp/toolkits/html/tools.ts) and projected tool items,
not recreate a second HTML transport or inject V1 message payloads. Decide explicitly whether old
fences need read-only rendering after transcript import; importing message text does not restore
the removed decoder. Preserve sandboxing, artifact ownership, local-media retention and copy
fallbacks, and add a setting only if the new service actually enforces it across providers.

## Pi extension status and autonomous work

Extension status is ephemeral session state, never transcript or projection data. It outlives
aborted work and is cleared only when the session ends or is replaced. Pi delegates through
app-owned MCP tasks and durable V2 child threads ([ADR 0004](../adr/0004-pi-delegates-through-rove-mcp.md));
old `<stateDir>/agent-transcripts` JSONL files remain on disk with no V2 query or cleanup.

Still deferred: extension-started work after the owning run settles stays stopped. Pi 1.2's
`agent_start` is too late for admission, since prompt preparation can already compact or run
extension hooks and custom-message turns bypass `prompt()`; its synchronous preflight callback
cannot hold work for V2 admission. Supporting wakes needs an awaited, cancellable worker-IPC
admission boundary covering user and custom messages, tied to the originating session/run and
invalidated by Stop or replacement, before
[ProviderContinuationService](../../apps/server/src/orchestration-v2/ProviderContinuationService.ts)
admits a committed run. Do not use Claude's `adapter_buffered` mode to justify already-started
work; replay and stale-wake coverage come first.

## Other notes

- [Migration-ID reconciliation](./legacy-orchestration-migration.md#divergent-migration-ids) in
  [Migrations.ts](../../apps/server/src/persistence/Migrations.ts) recognizes shipped Rove names at
  55–57 so upstream's different migrations can run on the copied database. The three V1 feature
  migrations were removed, not reserved at 63–65. Future upstream IDs require collision review;
  new fork schema must not claim a supposedly safe range in the upstream ledger.
- [Provider compatibility](../../apps/server/src/provider/providerCompatibility.ts) uses upstream
  adapter-generation baseline `0.0.46`, not Rove's release number. Advance it when adopting a newer
  upstream adapter generation, not for an unrelated Rove release.
