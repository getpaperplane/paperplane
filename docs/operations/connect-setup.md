# Paperplane Connect setup

Deployment and client configuration for Paperplane Connect. The [architecture note](../internals/paperplane-connect.md)
explains the trust boundaries; the [relay README](../../infra/relay/README.md#deployment) owns relay
provisioning instructions.

## Public application configuration

Paperplane Connect is disabled in a fresh clone. Copy the repository-root example to configure a
Paperplane-owned Clerk instance and relay; the placeholders do not enable cloud features:

```sh
cp .env.example .env
```

For another deployment, set these values in the repository-root `.env` or `.env.local`:

```dotenv
PAPERPLANE_CLERK_PUBLISHABLE_KEY=<publishable key>
PAPERPLANE_CLERK_JWT_TEMPLATE=<JWT template name>
PAPERPLANE_CLERK_CLI_OAUTH_CLIENT_ID=<public OAuth application client ID>
PAPERPLANE_RELAY_URL=https://relay.example.com
```

Process variables take precedence over `.env.local`, then `.env`. Use these canonical names;
the build loader supplies framework-specific aliases. These values are public identifiers.
`CLERK_SECRET_KEY` belongs only in the relay's secrets, never in client configuration.

Client and bundled-server builds embed the public values, so set them before building.
EAS preview and production environments need the publishable key, JWT template name, and relay URL.
Bundled servers also accept runtime overrides for operator-managed deployments.

Copy `infra/relay/.env.example` to `infra/relay/.env` for relay deployment settings.
Use an existing Neon Free project and supply its project ID, production branch name, and a
project-scoped API key as described in the relay README. Deploy `prod` before personal stages
because it owns their shared DNS zones and initializes the branch they fork. The stack's `PublishClientConfig` action
writes the resulting relay URL back to the root `.env`.

For an existing Connect deployment, the rename is a coordinated cutover, not an in-place client
update. Keep `PAPERPLANE_CLOUD_READY` off unless you actually operate Connect:

1. Preserve the `production` GitHub environment and the repository Cloudflare/Axiom credentials
   listed in the relay README after transferring to `getpaperplane/paperplane`. Keep the existing
   Neon project and production branch: the new migration changes only the default environment
   label, not saved user labels. Do not regenerate or edit applied migration files.
2. Configure Clerk's new `paperplane-relay` JWT template/audience, the new browser origins
   `https://paperplane.hafiezulzikry.com` and `https://paperplane-nightly.hafiezulzikry.com`, and the
   native redirects below. Remove the retired product's origins and redirects, while preserving
   unrelated applications. Otherwise sign-in or relay token exchange can fail after the cutover.
3. If you ship Apple-provisioned builds, register the `io.github.getpaperplane.paperplane` App ID
   family, matching App Groups, Associated Domains and keychain groups, regenerate profiles, and
   replace the `MACOS_PROVISIONING_PROFILE` release secret. Keep `APPLE_TEAM_ID`, `APPLE_API_KEY`,
   `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` authorized for the new IDs; self-signed releases do not
   need these. Register the corresponding iOS identities in Clerk and verify their AASA entries.
4. Set deployment `APNS_BUNDLE_ID=io.github.getpaperplane.paperplane` for production, with `.dev` or
   `.preview` for those builds. Verify `APNS_TEAM_ID`, `APNS_KEY_ID`, and `APNS_PRIVATE_KEY` authorize
   that topic. Register the new Android package family in Firebase, update build Firebase config,
   and authorize `FCM_SERVICE_ACCOUNT`. If publishing through stores/EAS, configure the new bundle
   IDs/package records, Expo project access (`PAPERPLANE_EXPO_OWNER`, `PAPERPLANE_EXPO_PROJECT_ID`,
   `EXPO_TOKEN`), and Play service-account access (`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`). Old package
   or topic settings make push delivery or store upload fail even when pairing works.
5. Deploy with the `paperplane-relay` workspace. The deployed identity deliberately keeps its
   pre-rename names: the `RoveRelay` Alchemy stack (the release workflow reads
   `RoveRelay/prod/output`), `roverelay-managedendpoint-<stage>-<digest>` tunnels, and the Axiom
   resources `rove-relay-traces-<stage>`, `rove-relay-otel-ingest-<stage>`,
   `rove-mobile-otel-ingest-<stage>`, `rove-relay-client-otel-ingest-<stage>`, and
   `rove-relay-recent-spans-<stage>`. Renaming any of them makes Alchemy create a parallel
   deployment (worker, database branch, tunnels, datasets) next to the live one.
6. Rebuild desktop, CLI, web and native mobile clients with the new public config and tracing
   tokens; enroll new passkeys and re-register mobile devices. Existing relay records can still
   reference old tunnel IDs, so inspect/reconcile allocations and relink hosts before removing
   obsolete tunnels. After verifying the replacement, retire the old stack's Worker, queues,
   tunnels and Axiom resources. Preserve the adopted Neon branch and DNS zones; do not blindly
   destroy the old stack. Missing redeployment/config leaves releases unable to read public config,
   clients unable to link, or diagnostics writing to retired datasets.

## CLI OAuth application

In Clerk's OAuth applications settings:

1. Create a public OAuth application for the Paperplane CLI, using authorization-code exchange with PKCE.
2. Allow the redirect URI `http://127.0.0.1:34338/callback`.
3. Enable the `openid`, `profile`, `email`, and `offline_access` scopes.
4. Enable **Device authorization grant** on the application. Headless and SSH authorization use
   it, and Clerk only advertises the device endpoint once it is on. The feature is in beta and
   Clerk enables it per account on request.
5. Set `PAPERPLANE_CLERK_CLI_OAUTH_CLIENT_ID` to the generated public client ID in local and release
   build environments.

## JWT template

Create a Clerk JWT template named `paperplane-relay` with claims:

```json
{ "aud": "paperplane-relay" }
```

Set `PAPERPLANE_CLERK_JWT_TEMPLATE=paperplane-relay` for clients and
`CLERK_JWT_AUDIENCE=paperplane-relay` for the relay. The production relay deployment environment
also defines `CLERK_JWT_TEMPLATE`. The audience stays the same across relay stages; the relay
URL selects the deployment.

## Desktop OAuth redirects

Enable Clerk's Native API and add the desktop redirects to its SSO redirect allowlist:

```text
paperplane-dev://app/
paperplane://app/
```

Add the corresponding origin to the Clerk instance's Backend API `allowed_origins` array.
Development uses `paperplane-dev://app`; production uses `paperplane://app`. Update the array with
`PATCH https://api.clerk.com/v1/instance` using the Clerk secret key. Retire the previous product's
entries, preserving unrelated applications.
The Clerk Electron integration handles token
persistence and system-browser callback delivery.

## Android native sign-in redirects

Clerk's native Android SDK uses `clerk://<applicationId>.callback`. In the Clerk instance selected by the app's publishable key, add each supported package to **Native applications > Allowlist for mobile SSO redirect**:

| Variant     | Callback                                                      |
| ----------- | ------------------------------------------------------------- |
| Development | `clerk://io.github.getpaperplane.paperplane.dev.callback`     |
| Preview     | `clerk://io.github.getpaperplane.paperplane.preview.callback` |
| Production  | `clerk://io.github.getpaperplane.paperplane.callback`         |

Remove the previous product's callbacks and preserve unrelated applications. These callbacks are separate from the `paperplane-dev` / `paperplane-preview` / `paperplane` navigation schemes. A private development build using the production Clerk key still needs its development callback allowed by that instance's administrator; rebuilding the same package does not change the allowlist.

## Desktop passkeys

Paperplane uses a new Apple identity, with no Rove Code passkey or keychain-group
bridge. Official self-signed releases do not enable these passkeys, and Connect
remains gated off. Operators of a private Connect setup must register the new App IDs,
regenerate provisioning profiles, and enroll new passkeys. Update both the desktop and
iOS entries in Clerk; `webcredentials.apps` must list each signed identity you use,
such as `<TEAM_ID>.io.github.getpaperplane.paperplane`,
`<TEAM_ID>.io.github.getpaperplane.paperplane.dev`, and
`<TEAM_ID>.io.github.getpaperplane.paperplane.preview`.

For a production macOS app with bundle ID `io.github.getpaperplane.paperplane`:

1. Create an explicit macOS App ID in the Apple Developer portal with **Associated Domains**.
2. Create a provisioning profile for that App ID and the distribution signing certificate.
3. In Clerk's Native API settings, add an iOS app with the same Apple Team ID and bundle ID.
   This setting also configures Electron/macOS passkeys.
4. Check `https://<frontend-api>/.well-known/apple-app-site-association`. Its
   `webcredentials.apps` must include `<TEAM_ID>.io.github.getpaperplane.paperplane`.
5. The Touch ID access group is `<TEAM_ID>.io.github.getpaperplane.paperplane.webauthn`.
   Use the matching bundle-ID suffix for separately signed development apps.
6. Apple provisioning is separate from [Paperplane's self-signed release mode](./release.md#build-self-signed-macos-artifacts-without-apple-membership), which does not enable native passkeys or notarization. Use Developer ID signing with the Apple credentials and provisioning profile when testing this setup.

Local signed builds additionally use:

```dotenv
PAPERPLANE_APPLE_TEAM_ID=ABC1234567
PAPERPLANE_MACOS_PROVISIONING_PROFILE=/absolute/path/to/paperplane.provisionprofile
# Override only when the RP domain differs from the Clerk Frontend API hostname.
PAPERPLANE_CLERK_PASSKEY_RP_DOMAINS=example.clerk.accounts.dev,clerk.example.com
```

Without the override, the build derives the RP domain from the Clerk publishable key.
After changing Associated Domains, bump the build version before rebuilding. macOS can otherwise
reuse stale Shared Web Credentials metadata for the same app/version pair.

The ordinary `dev:desktop` launcher is unsigned and cannot exercise macOS passkeys. For renderer
HMR, install a signed build, start `vp run dev:web`, and launch the installed executable with the
actual web and server ports. For example, with the default ports:

```sh
VITE_DEV_SERVER_URL=http://127.0.0.1:5733 \
PAPERPLANE_PORT=13773 \
  "/Applications/Paperplane (Beta).app/Contents/MacOS/Paperplane (Beta)"
```

Rebuild the signed app after native dependency, main-process, preload, entitlement, provisioning,
or signing changes. Renderer edits can reuse it. Verify the installed bundle before testing:

```sh
codesign --verify --deep --strict "/Applications/Paperplane (Beta).app"
codesign -d --entitlements :- "/Applications/Paperplane (Beta).app"
```

## Restricting sign-ups

Use Clerk's allowlist for permitted email addresses or domains, or Restricted mode for invitation-only
sign-up. An enabled empty allowlist blocks all new sign-ups.

Sign-up restrictions do not revoke an existing account's access. Ban the account in Clerk when
its active sessions and future sign-ins must be disabled.
