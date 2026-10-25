# Product analytics

The server owns PostHog delivery, opt-out, and identity for every connected client.
[Identity selection](../../apps/server/src/telemetry/Identify.ts) hashes a random
installation-scoped ID without reading provider credentials. This identity can
span several clients on the same server; it does not identify a browser session
or link separate installations through a provider account. Clients do not load
the PostHog browser SDK. Client-use events require an authenticated connection, so
visiting the hosted app without connecting does not count as product use.

## Attribution boundaries

Client dimensions belong to the event's WebSocket connection. A server-global
"current client" would misattribute simultaneous web, desktop, and mobile use.
Provider execution has its own events because a turn can outlive the requesting
connection.

Keep client and server dimensions separate. A desktop host can serve a phone or a
remote browser, and a direct connection can cross a network. Older clients omit
metadata. Missing client values must stay unknown rather than being backfilled
from server properties. The legacy `clientType` property describes how the server
runs; use `surface` for the connected client.

## Interpreting events

Use `client.turn.requested` for active-use reports. `client.connected` counts
reconnects, so network behavior can inflate it. One identity can appear in several
client groups during a period; adding those groups double-counts users.

Read-heavy `client.feature.used` operations are counted once per operation per WebSocket connection,
not once per query or keystroke. Their outcomes and durations describe the RPC operation. Feature
events for orchestration commands describe acceptance, not completion of asynchronous side effects.
Filter `analyticsEnvironment` to `production` for shipped-product reports; isolated verification can
set `PAPERPLANE_ANALYTICS_ENVIRONMENT=test`.

Provider send and completion counts need not match. Providers can emit synthetic
turns without a send request. Collection is best effort, with no scan or backfill
of provider history.

Token totals cover the main agent. Child agents and model rerouting prevent a turn
from representing one provider/model combination's full cost. For provider
comparisons, require complete usage, no observed subagents, and no mixed models;
compare matching model, effort, interaction mode, and terminal status. Aggregate
output/input ratios should divide the summed totals. Averaging per-turn ratios
lets small-input turns dominate.

Unknown counts stay absent. Partial usage contains valid observed counts but
cannot establish a whole-turn total. Keep these distinctions when changing token
normalization or building reports.

## Delivery

A send can fail after PostHog has stored the batch, so every retry is a copy.
[Delivery](../../apps/server/src/telemetry/AnalyticsService.ts) gives each event a
uuid when it is recorded, backs off after a failed send, and drops a batch after a
few tries. Without these limits, one stuck batch was sent every second for days.

## Collection boundary

Keep analytics payloads to product metadata and normalized measurements. Do not
send prompts, authentication material, raw provider payloads, user-assigned device
names, or conversation identifiers. Client metadata is best effort; invalid values
must not reject a connection. The final delivery boundary in
[`AnalyticsPolicy.ts`](../../apps/server/src/telemetry/AnalyticsPolicy.ts) allowlists events and validates
individual metadata properties; unknown keys and invalid values are omitted. Do not forward RPC
inputs, results, or trace attributes into analytics. Only production client-use events enable
PostHog person-profile processing, keyed by the existing random installation identifier. No person
properties or account linkage are sent. Boot/provider-only and development/test events do not request
profile creation. A previously created profile may still associate events using the same distinct ID.
GeoIP enrichment is disabled and the event IP property is null.

The persisted environment-wide opt-out and `PAPERPLANE_TELEMETRY_ENABLED=false` both stop collection.
The environment variable wins. Identity lookup is lazy, and opting out discards queued events;
already-sent requests cannot be recalled.
