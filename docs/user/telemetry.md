# Product usage data

The Paperplane server sends product usage events to Paperplane's PostHog project, associated with a
hashed random installation identifier. Provider account IDs are not used. Events include the
provider, model, reasoning effort, permission mode, turn result, duration, and main-agent token
totals when available. Paperplane also measures explicit feature operations (such as opening a terminal,
reviewing a diff, searching, or creating a worktree), their outcomes, and their durations. Events
include app version and coarse client/platform metadata; development and test traffic is labeled
separately from production.

Production client activity creates a minimal PostHog profile keyed only by that random installation
identifier, so Paperplane can measure returning installations. No name, email, or provider account identity
is attached, and location enrichment is disabled. An installation can serve several clients or
people, and one person can use several installations; these counts are not a census of unique people.
Background-only hosts and development/test traffic do not create profiles.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, device names or exact device models, commands, terminal output, or child-agent
output. There is no automatic click capture, session replay, or cross-installation identity linking.
Child-agent token use is excluded from the totals.

Disable **Share product usage data** in Settings → General (web/desktop), or Settings → Maintenance
(mobile). The preference applies to all clients connected to the selected environment, takes effect
without restarting, and discards queued events. Requests already in flight cannot be recalled.
Turn it back on there to resume collection.

Setting `PAPERPLANE_TELEMETRY_ENABLED=false` in the server's environment before starting it always overrides
the Settings preference. While collection is disabled, analytics does not access or create the
installation identifier.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > General > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`PAPERPLANE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. For endpoints saved here or set with `PAPERPLANE_OTLP_*_URL`, set `PAPERPLANE_OTLP_HEADERS` for
receivers that need authentication and `PAPERPLANE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
