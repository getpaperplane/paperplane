# Product usage data

The Rove Code server sends product usage events to Rove's PostHog project, associated with a
hashed random installation identifier. Provider account IDs are not used. Events include the
provider, model, reasoning effort, permission mode, turn result, duration, and main-agent token
totals when available. Rove also measures explicit feature operations (such as opening a terminal,
reviewing a diff, searching, or creating a worktree), their outcomes, and their durations. Events
include app version and coarse client/platform metadata; development and test traffic is labeled
separately from production.

Production client activity creates a minimal PostHog profile keyed only by that random installation
identifier, so Rove can measure returning installations. No name, email, or provider account identity
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

Setting `ROVE_TELEMETRY_ENABLED=false` in the server's environment before starting it always overrides
the Settings preference. While collection is disabled, analytics does not access or create the
installation identifier.
