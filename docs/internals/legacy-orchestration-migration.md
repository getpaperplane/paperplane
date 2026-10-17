# Legacy orchestration migration

Orchestration v2 snapshots `state.sqlite` into `statev2.sqlite` before opening writable persistence
on its first launch. Only the copy receives v2 migrations; the original remains available to v1.
Subsequent launches reuse the copy without refreshing it from v1. It creates v2 thread shell events first and imports
the complete user and assistant transcript lazily when a client reads or continues the thread. The
v1 shell and message projections remain the import source. The untouched `state.sqlite`, not the
v1 tables inside `statev2.sqlite`, is the recovery source if an import needs investigation.

## Imported data

The shell import preserves the project and thread identifiers, title, provider and model selection,
runtime and interaction modes, branch, worktree path, creation and update times, archive and delete
times, settlement override and timestamps, snooze timestamps, pin timestamp and order, and linked
pull request. The metadata repair path fills snooze, pin order, `unsettledAt`, and linked pull request
fields for threads imported before those fields were covered.

Transcript import reads user and assistant rows from `projection_thread_messages`. It preserves
message identifiers, text, supported attachments, timestamps, role, and ordering. A message that was
still streaming becomes an interrupted turn item.

The importer does not translate provider session identity, native provider runs, checkpoints and
diffs, activities and tool calls, approvals, or proposed plans. V2 therefore must not present those
records as migrated history.

## First continuation

A migrated thread has no active provider thread. Its first continuation creates a fresh provider
session and sends a legacy handoff built only from user and assistant messages. The handoff selects
the newest transcript suffix within a 32,000-character budget, including section labels and the
import notice. This budget is separate from portable provider handoffs.

## Client and server cutover

Clients and servers must agree on `ORCHESTRATION_PROTOCOL_VERSION` (currently 2). The client
runtime appends `orchestrationProtocol=2` to the socket URL, and the `/ws` route rejects a missing
or mismatched version with HTTP 426 (`orchestration_protocol_incompatible`) before any RPC or auth
work runs. The client checks the environment descriptor the same way: a missing version means the
host predates protocol 2, and a different version means both sides need updating. Either direction
blocks the connection as `unsupported` with a message naming the machine to update rather than
running half-upgraded. See `packages/client-runtime/src/connection/compatibility.ts` and
`apps/server/src/ws.ts`.

## Divergent migration ids

`effect_sql_migrations` records `migration_id` and `name`, but the migrator compares ids only:
rows at or below the recorded maximum are skipped without checking names. A database that ran a
local or fork migration under an id this build later assigns to a different migration therefore
never receives this build's migration at that id. After repairing supported V2 preview ledgers,
[`runMigrations`](../../apps/server/src/persistence/Migrations.ts) rejects history that would skip a
requested migration at id 55 or later without its expected name. Earlier name clashes remain
warnings for compatibility with site-local migrations. There is no safe id range for a fork inside
this ledger: any id at or below a future upstream id masks it forever, so fork schema changes belong
in a separate migration table or outside the migrator entirely.

## Retiring copied v1 data

[`LegacyV1StorageMaintenance`](../../apps/server/src/persistence/LegacyV1StorageMaintenance.ts)
runs in background storage maintenance, outside the shared migration ledger. It checks for both
unimported shells and unfinished transcripts before atomically dropping unused v1 activities, turns,
approvals, plans, projector state, and checkpoint diff blobs (including their indexes). Shell and
message projections and pull request links remain for importer reconciliation; `projection_projects`
is still the shared project read model, and session projections remain for settings provider history. The shared `orchestration_events` and
`orchestration_command_receipts` tables must not be dropped: v2 uses them too. Existing history
compaction removes imported v1 thread events and receipts in bounded batches.

DROPs run on a worker while reserving the server writer without a transaction, so foreground writes
wait asynchronously and WAL readers continue. The worker checks eligibility and drops in one
transaction; interruption rolls it back and a later pass retries. This work starts after activation,
not on the readiness path. Historical migrations (including settlement repair) have already run;
restarting uses their existing ledger rather than replaying them against retired tables.

On older databases with `auto_vacuum=NONE`, dropping tables frees pages for reuse but cannot shrink
the file. Stop the app/server and run `rove doctor` against the same home to reclaim them. Its
offline VACUUM rebuilds the database with incremental auto-vacuum; subsequent background reclamation
returns free pages online. Do not VACUUM automatically in the live server: even on a worker it holds
the writer for the entire rebuild, needs substantial temporary disk space (potentially twice the
database size), and competes with active readers/checkpoints. Merely setting incremental auto-vacuum
on an existing file does not avoid that rebuild. The Storage page reports reclaimable space and the
host-specific doctor command.

## Recovery

There is no supported whole-thread export API. Recovery uses an untouched copy of the environment's
`userdata` directory and opens that copy with SQLite's read-only mode. The user guide documents the
queries against `projection_threads` and `projection_thread_messages`. Never start a server against
the recovery copy because startup can run migrations and write new state.
