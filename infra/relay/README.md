# Paperplane Connect Relay

> [!NOTE]
> Sign in to Paperplane Connect from the app under Settings > Connections.

The relay is the hosted control plane for Paperplane Connect. It helps clients discover and connect to
remote environments, manages the cloud-side records needed for those connections, and delivers
optional mobile notifications and Live Activities.

The relay is intentionally not in the hot path for normal Paperplane traffic. After a client connects,
regular API and WebSocket traffic goes directly between that client and the selected environment.
See the [Paperplane Connect architecture note](../../docs/internals/rove-connect.md) for the larger system
design.

## Responsibilities

The relay currently owns:

- Linking Paperplane environments to a cloud account.
- Provisioning and tracking managed environment endpoints.
- Issuing short-lived credentials used to connect clients to linked environments.
- Listing linked environments and registered mobile devices for an account.
- Registering mobile notification preferences and APNs or FCM tokens.
- Receiving published agent activity and delivering notifications or Live Activity updates.
- Persisting relay state and exposing relay-specific traces for diagnostics.

The environment server and relay have separate credentials and trust boundaries. Read
[Environment Authentication Profile](../../docs/internals/environment-auth.md) before changing token,
credential, or authorization behavior.

## Code Map

- [`alchemy.run.ts`](./alchemy.run.ts) defines the deployed Alchemy stack.
- [`src/worker.ts`](./src/worker.ts) wires Cloudflare bindings, runtime layers, queues, and HTTP APIs.
- [`src/http/Api.ts`](./src/http/Api.ts) contains the relay HTTP handlers and authentication
  boundaries.
- [`src/environments`](./src/environments) contains environment linking, credentials, endpoint
  provisioning, and connection flows.
- [`src/agentActivity`](./src/agentActivity) contains mobile device registration, activity state,
  APNs and FCM delivery, and queue processing.
- [`src/auth`](./src/auth) contains relay token and DPoP proof handling.
- [`src/persistence/schema.ts`](./src/persistence/schema.ts) defines persisted relay state. Keep
  schema and migration changes together.

Shared request and response schemas live in
[`packages/contracts/src/relay.ts`](../../packages/contracts/src/relay.ts). Shared client-side relay
calls live in
[`packages/client-runtime/src/relay/managedRelay.ts`](../../packages/client-runtime/src/relay/managedRelay.ts).

## Working Locally

Install dependencies from the repository root, then run relay-focused checks from this directory:

```sh
vp install
cd infra/relay
vp test run
vp run typecheck
```

To run a smaller test set while iterating:

```sh
vp test run src/environments/EnvironmentLinker.test.ts
```

Before considering a change complete, run the repository-wide checks from the root:

```sh
vp check
vp run typecheck
```

Backend changes should include tests. Prefer testing the real business logic with external
dependencies represented at their boundary rather than mocking internal behavior.

## Deployment

The relay deploys with the Alchemy CLI (`vp run --filter rove-relay deploy` is `alchemy deploy`
in this directory):

```sh
vp run --filter rove-relay deploy
```

The stack provisions the Cloudflare Worker and queues, managed endpoint resources, database
connectivity, and relay tracing resources. Copy [`infra/relay/.env.example`](./.env.example) to
`infra/relay/.env` and fill in the deployment-specific values before deploying. Alchemy loads that
file from the relay directory. Runtime secrets include Clerk, APNs, and optional FCM credentials. Set
`APNS_ENABLED=false` for an Android-only development deployment without Apple credentials. Production adopts
the configured API and tunnel DNS zones as retained Cloudflare resources. Personal stages reference
the production-owned zones.

Create a Neon project on the **Free** plan, with Postgres only and no payment method. Set
`NEON_PROJECT_ID` to its ID and `NEON_PRODUCTION_BRANCH` to its existing default branch name
(`production` for new console projects). Create a project-scoped API key for `NEON_API_KEY`; it
cannot create projects or change organization billing.

The `prod` Alchemy stage adopts and retains that branch, applying the committed Postgres migrations.
After changing the schema, run `vp run db:generate` from `infra/relay`, review the SQL, and commit it
before deployment. Deployment does not generate new migrations.
Personal stages fork separate branches from it, including data and applied migration history.
Deployment does not provision a paid database. Deploy `prod` before personal stages because it also
owns the shared DNS zones. Existing PlanetScale deployments require an explicit Postgres data
export/restore into Neon before switching; this stack does not transfer their data automatically.

For a low-traffic Free deployment, set `RELAY_MAINTENANCE_SCHEDULE=0 * * * *` to let Neon suspend
between maintenance runs. Free compute, storage, and Cloudflare usage still have limits; this is
not unlimited free hosting. Do not upgrade the plans to work around those limits.

Deploy production first:

```sh
vp run --filter rove-relay deploy -- --stage prod
vp run --filter rove-relay deploy -- --env-file .env.local
```

Alchemy defaults personal deployments to the `dev_$USER` stage. Relay custom domains apply the same
DNS-safe sanitization as Alchemy physical resource names, so `prod` uses
`relay.<RELAY_API_ZONE_NAME>` and `dev_julius` uses
`relay-dev-julius.<RELAY_API_ZONE_NAME>`. Managed environment endpoints are provisioned below
`RELAY_TUNNEL_ZONE_NAME`, which may be a different Cloudflare zone. Production tunnel hostnames use
`prod-<digest>.<RELAY_TUNNEL_ZONE_NAME>`; personal stages use
`<stage>-<digest>.<RELAY_TUNNEL_ZONE_NAME>`. `RELAY_DOMAIN` remains available as an explicit API
domain override.

The stack's `PublishClientConfig` action ([`src/clientConfig.ts`](./src/clientConfig.ts)) writes the
deployed relay URL and tracing configuration into the repository-root `.env`, so subsequent source
builds point at the relay that was just deployed without copying values manually. It runs only when
one of those outputs changed, and `ROVE_RELAY_CLIENT_CONFIG_ENV` redirects it to another file.

### Deployment CI

The relay is versioned separately from client releases. `.github/workflows/deploy-relay.yml` deploys
the shared Alchemy `prod` stage on pushes to `main` when `ROVE_CLOUD_READY=true`. For initial
setup, run it manually with `dry_run=true` to inspect the plan, then `dry_run=false` to apply it.
Manual deployment leaves the release readiness gate unchanged. Planning may initialize Alchemy's
free Cloudflare state-store Worker before it plans relay resources.

Stable and nightly release builds resolve their static public config from the same `production`
GitHub environment. Pull requests do not deploy relay stages. Developers can deploy personal
non-production stages locally with any stage name other than `prod`.

The repository must define these Actions variables shared by relay deployments:

- `CLOUDFLARE_ACCOUNT_ID`
- `AXIOM_ORG_ID`

The repository must define these Actions secrets shared by relay deployments:

- `CLOUDFLARE_API_TOKEN`
- `AXIOM_TOKEN`

The `production` GitHub environment must define these Actions variables:

- `NEON_PROJECT_ID`
- `NEON_PRODUCTION_BRANCH` (defaults to `production`)
- `RELAY_MAINTENANCE_SCHEDULE` (CI defaults to hourly)
- `RELAY_API_ZONE_NAME`
- `RELAY_TUNNEL_ZONE_NAME`
- `RELAY_DOMAIN` if overriding the derived production relay domain
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_AUDIENCE`
- `CLERK_JWT_TEMPLATE`
- `CLERK_CLI_OAUTH_CLIENT_ID`
- `APNS_ENABLED` (`false` when Apple push is not configured)
- `APNS_ENVIRONMENT` (required only when APNs is enabled)
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_BUNDLE_ID`

The `production` GitHub environment must define these Actions secrets:

- `NEON_API_KEY` (project-scoped)
- `CLERK_SECRET_KEY`
- `APNS_PRIVATE_KEY` (required only when APNs is enabled)
- `FCM_SERVICE_ACCOUNT` when Android push is enabled

The account-scoped repository credentials are consumed by Alchemy while provisioning relay stages; they
are not bound into the relay Worker. Prefer an organization-scoped advanced Axiom API token with
management access to datasets, views, and API tokens, plus dataset ingest and query access. Billing
permissions are not needed. Set `AXIOM_ORG_ID` alongside `AXIOM_TOKEN` to target the organization
explicitly; a personal access token also works but grants broader account access.
The release workflow reads the production relay's
derived public URL and Clerk publishable key from the same environment for downstream desktop, CLI,
and hosted web builds.

See:

- [Paperplane Connect setup](../../docs/operations/connect-setup.md) for Clerk keys, JWT templates, and sign-up restrictions.
- [Relay Observability](../../docs/operations/relay-observability.md) for deployment tracing and diagnostics.
- [Paperplane Connect architecture](../../docs/internals/rove-connect.md) for environment linking and trust boundaries.
