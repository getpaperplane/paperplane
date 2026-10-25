# Releasing Paperplane

> Maintainer procedure. Public installation instructions live in [the user guide](../user/install.md).

## Current status

`.github/workflows/release.yml` schedules nightlies daily at 00:00 UTC from the default branch. Scheduled runs skip building and publishing when there are no commits ahead of the latest published nightly or that nightly was published less than six hours ago. Publication requires `PAPERPLANE_RELEASE_READY=true`; do not enable it as a shortcut around the gates below.

Manual runs support stable, nightly, and preview, and default to `build_only=true`: checked produces downloadable Actions artifacts without publishing to npm or creating a GitHub Release. Uncheck it to publish; npm uses `latest` for stable, `nightly` for nightly, and `preview` for preview. Manual nightly and preview runs build the selected ref without the scheduled no-change check. Publishing stable builds the latest published nightly's commit, with its base version unless a version override is supplied. The override changes the version, not the commit. Stable build-only runs instead build the selected ref and require an explicit version; nightly and preview generate their own versions.

npm can take over an hour to serve a large platform package it has already accepted, and until then `@getpaperplane/cli` installs without an executable. Each platform package publishes independently once its own CLI archive and quality checks are ready, overlapping the other CLI and desktop builds with npm propagation. A failed desktop build can leave unused platform versions on npm; the launcher still requires every desktop build to pass and waits up to two hours for npm to serve every platform package. Nothing else waits on the launcher job: the GitHub Release, hosted web app, and announcement ship as soon as the desktop builds pass, so the run can stay in progress after the release is out. If the npm job fails or times out, use **Re-run failed jobs** rather than a new run: the rerun publishes the same version and skips packages npm already serves.

A release skips its own quality checks when CI has already passed on a push of the same commit, which is the usual case for nightlies built from `main`.

The first release is **self-hosted desktop and persistent CLI hosts, with local, LAN, Tailscale, and desktop SSH connections**. Leave `PAPERPLANE_CLOUD_READY` unset: relay deployment and configuration are skipped, and desktop/CLI builds omit Paperplane Connect. Apple and Azure signing credentials may be omitted for unsigned builds. Signed macOS previews require `PAPERPLANE_MACOS_SIGNING_READY=true`; mobile store distribution requires `PAPERPLANE_MOBILE_STORES_READY=true` and paid developer accounts. Free APK/unsigned IPA distribution has a separate `PAPERPLANE_MOBILE_SIDELOAD_READY` gate. Hosted web and marketing retain separate readiness controls; those controls indicate release readiness, not necessarily a paid service.

The static browser app deploys to Cloudflare. See the [Cloudflare deployment procedure](./cloudflare-web.md). When `PAPERPLANE_CLOUDFLARE_WEB_READY=true`, stable releases deploy to `paperplane.hafiezulzikry.com` and nightlies deploy to the separate `paperplane-nightly.hafiezulzikry.com` origin. Preview releases deploy neither. Marketing deploys only on stable releases when `PAPERPLANE_MARKETING_RELEASE_READY=true`. These deployments do not require the relay gate.

## One-time Paperplane cutover

Complete these account and deployment steps around the rename merge. They are maintainer actions,
not steps performed by the rename scripts. Keep disabled release channels disabled.

1. Before transferring the repository, test the old desktop updater against GitHub's redirect behavior
   on an isolated installation. Prepare the transfer to `getpaperplane/paperplane`: check GitHub App
   installations, organization-secret access, environment protections, branch rules and vulnerability
   reporting for the destination organization. The release App needs
   Contents write access and permission to make the version-bump commit; its secrets remain
   `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY`.
2. Before merging, copy the old readiness settings to the following repository variables, preserving
   their intended values, not turning every gate on:
   `PAPERPLANE_RELEASE_READY`, `PAPERPLANE_CLOUDFLARE_WEB_READY`, `PAPERPLANE_CLOUD_READY`,
   `PAPERPLANE_HOSTED_RELEASE_READY`, `PAPERPLANE_MACOS_SIGNING_READY`,
   `PAPERPLANE_MARKETING_RELEASE_READY`, `PAPERPLANE_MOBILE_SIDELOAD_READY`, and
   `PAPERPLANE_MOBILE_STORES_READY`. Copy the Android secrets to
   `PAPERPLANE_ANDROID_KEYSTORE_BASE64`, `PAPERPLANE_ANDROID_KEYSTORE_PASSWORD`,
   `PAPERPLANE_ANDROID_KEY_ALIAS`, and `PAPERPLANE_ANDROID_KEY_PASSWORD`. Copy the Cursor webhook
   secrets to `CURSOR_PAPERPLANE_WEBHOOK_URL` and `CURSOR_PAPERPLANE_WEBHOOK_AUTH`.
   Each replaces the same suffix under the former product prefix. Missing gates silently skip their
   channels; missing Android secrets skip APKs; missing Cursor secrets disable webhook delivery.
3. Verify ownership of the `@getpaperplane` npm organization and all six CLI packages listed below.
   Configure each trusted publisher for owner `getpaperplane`, repository `paperplane`, workflow
   `release.yml`. CI uses npm OIDC, not an `NPM_TOKEN` secret. If using a token for the initial manual
   publication, grant it access to this organization and every package. Without publisher access,
   the next nightly's npm jobs fail even if GitHub artifacts ship.
4. Generate new macOS and Windows self-signed identities named **Paperplane Release Signing** using
   the procedures below. Replace `CSC_LINK` and `CSC_KEY_PASSWORD` for macOS, and `WIN_CSC_LINK` and
   `WIN_CSC_KEY_PASSWORD` for Windows. Keep `MACOS_SIGNING_MODE=self-signed` and
   `WINDOWS_SIGNING_MODE=self-signed` for those release modes. Remove an obsolete
   `MACOS_SIGNING_IDENTITY` override or set it to `Paperplane Release Signing`. Exported Windows
   files are `paperplane-windows-signing.pfx` (private) and `paperplane-windows-signing.cer` (public).
   Old secrets or an old identity override either fail signing or keep signing with the retired
   certificate. Existing installations must reinstall; Windows users must trust the new public
   certificate. Do not enable the Apple-signing readiness gate for self-signed builds.
5. Follow [Cloudflare web](./cloudflare-web.md) to deploy `paperplane-web`, `paperplane-web-nightly`,
   and `paperplane-marketing` on their new custom domains and retire the previous origins without
   redirects. Preserve the `cloudflare-web` GitHub environment's `CLOUDFLARE_ACCOUNT_ID` and
   `CLOUDFLARE_API_TOKEN` secrets and their access after transfer. Verify
   `https://paperplane.hafiezulzikry.com/schema/paperplane.json` serves JSON Schema, not the SPA.
   Skipping deployment leaves new pairing, download, and schema links unavailable; users pair again
   at the new browser origins because cookies and browser storage do not cross origins.
6. Only if Connect is enabled, complete [Connect setup](./connect-setup.md) before building clients.
   Deploy the matching protocol-version-2 relay under the `PaperplaneRelay` stack, then rebuild all
   clients with its new URL, JWT audience and tracing outputs. A release with Connect enabled reads
   `PaperplaneRelay/prod/output`; without that deployment its public-config job fails. Do not enable
   `PAPERPLANE_CLOUD_READY` just to exercise the rename.
7. At merge time, transfer and rename the repository to `getpaperplane/paperplane`, update local
   remotes, and recheck App/secret access and branch rules. Stage desktop, CLI and new native mobile
   binaries together. Test an upgrade with existing
   preferences, notification history, credentials, checkpoint refs and worktree threads against
   isolated copies. Publish release notes requiring a manual desktop/CLI/mobile reinstall and mobile
   re-pairing; old CLI updaters expect the old archive and executable names. Tell users to rename
   `rove.json` to `paperplane.json` (including `$schema`), `.rove/vcs.json` to `paperplane.vcs.json`,
   update personal MCP permissions to `mcp__paperplane__*`, reinstall capture helpers, and rerun
   browser sandbox setup if used. Service users install the new CLI and run `paperplane service
install` to retire the recognized old service. Android widgets may need adding again.
8. After the first new npm release is live and verified, deprecate the old scoped CLI/platform
   packages with a pointer to `@getpaperplane/cli`. Do not deprecate them before a replacement exists.
   Retain the frozen old home/profile backups through the migration window.

Updates from the previous orchestration system preserve transcripts but cannot carry all runtime history forward. Before testing an upgrade, read [Threads from older Paperplane versions](../user/thread-migration.md) and verify the `statev2.sqlite` migration against isolated data.

## Before enabling publication

1. Confirm that the repository, domains, npm scope, signing accounts, vulnerability reporting, and legal/support contacts belong to this project. Preserve upstream MIT attribution. In particular, verify ownership of the `@getpaperplane` npm scope and configure trusted publishing for `@getpaperplane/cli` and every `@getpaperplane/cli-<platform>` package; a package-name lookup alone does not prove control.
2. Run `node scripts/check-release-identity.mjs` and triage each finding. Stray old-name identifiers anywhere in tracked or non-ignored source block publication regardless of gates. Explicit exceptions cover one-time migration units and inputs, immutable ledgers/recordings, historical documentation and retained external-resource lookups. Public upstream claims on marketing, hosted-web, and mobile surfaces are also reported; those claims block only when that surface's readiness variable is enabled. Saved-data and protocol identifiers require explicit migrations, not bulk replacements; package names, public URLs, downloads, and legal claims must point to Paperplane-owned resources or be removed.
3. Keep the source server workspace package (`apps/server/package.json`, `name: @getpaperplane/server`) private. Its name is used by Effect's deterministic service keys; it is **not** the published CLI. `scripts/build-npm-platform-packages.ts` produces the separate `@getpaperplane/cli` launcher, its `paperplane` command, and the platform packages. The source package must never be published.
4. Verify the installer, archive, npm launcher, SSH runtime, WSL payload, desktop identity, and background service resolve to the **same** Paperplane artifact and isolated state paths. The default home is `~/.paperplane`. The first default-home start copies the previous product's data once, with SQLite backup-API snapshots and no overwrites; an explicit home bypasses that conversion. Test only with isolated copies, never the live inherited directory.
5. Keep `PAPERPLANE_CLOUD_READY`, `PAPERPLANE_MOBILE_STORES_READY`, and `PAPERPLANE_MACOS_SIGNING_READY` off until their paid infrastructure or credentials are available. Keep hosted web (`PAPERPLANE_CLOUDFLARE_WEB_READY`) and marketing (`PAPERPLANE_MARKETING_RELEASE_READY`) off until their independent deployment review is complete. The source-only marketing page uses this repository's free GitHub build guides; set `PAPERPLANE_MARKETING_SITE_URL` to a verified deployed origin before publishing for canonical and social URLs. Without it those tags are omitted. Review and replace the inherited legal pages and desktop screenshot before enabling marketing; the text check cannot inspect image assets.
6. Check repository CI and focused tests under the supported Node version (`package.json`). Build the platform matrix on its supported hardware, verify signatures/notarization as applicable, and inspect every archive and npm tarball for package identity, executable name, URL, and checksum. Verify release notes and update metadata refer only to this repository.
7. **Download the Paperplane-built artifacts** from a staging release and test them on clean machines: macOS arm64/x64, Linux x64/arm64, Windows x64/arm64, plus CLI archive and npm launcher for each supported target. Exercise installation, first run, local and LAN pairing, Tailscale HTTPS, service install/restart/uninstall, systemd-enabled WSL, and upgrade/rollback. Verify that the address, port, provider PATH, environment ID, paired-client authorization, and threads survive an update. Verify that disconnecting desktop SSH leaves its host service running. Connect deployments must also retain cloud links and recover their managed tunnel after updates. Native Windows service installation must fail with its supported-platform explanation, not fall back to a disposable process. Confirm that state outside the selected Paperplane home is untouched. Source-tree tests alone do not clear this gate.
8. Review the result with a maintainer before enabling the release variable, tag/schedule triggers, or any publisher. Publish only the paths that passed staging. Keep disabled channels disabled.

No credentials or production databases should be copied into a worktree for verification. Use isolated development state. Do not publish to npm or create a GitHub Release while investigating failures.

## Publish mobile sideload binaries without store accounts

The repository Actions variable `PAPERPLANE_MOBILE_SIDELOAD_READY=true` enables `.github/workflows/mobile-sideload.yml` from
stable/nightly/preview releases (including build-only runs).
`PAPERPLANE_MOBILE_STORES_READY` remains unchanged and can stay off.
No Apple, Play Console, Expo/EAS, or cloud credentials are needed. These builds
leave `PAPERPLANE_CLOUD_READY` unset and OTA updates off.

1. Generate an Android release key **outside the repository**, once:

   ```sh
   mkdir -p "$HOME/.config/paperplane-release-signing"
   keytool -genkeypair -v -storetype PKCS12 \
     -keystore "$HOME/.config/paperplane-release-signing/android.p12" \
     -alias paperplane-release -keyalg RSA -keysize 3072 -validity 10000
   ```

2. **Back up the keystore and password securely.** Reuse the same key for every
   release: losing or changing it prevents Android updates over existing installs.
   Add these repository Actions secrets (never print or commit their values):
   - `PAPERPLANE_ANDROID_KEYSTORE_BASE64`: Base64 of the keystore file.
   - `PAPERPLANE_ANDROID_KEYSTORE_PASSWORD`: its store password.
   - `PAPERPLANE_ANDROID_KEY_ALIAS`: `paperplane-release` from the command above.
   - `PAPERPLANE_ANDROID_KEY_PASSWORD`: the key password (same as the store password for
     this PKCS12 command).
     If any is missing, Android is explicitly skipped; iOS still builds. Invalid
     credentials fail the Android build. Published APKs never use a debug key.
3. Push the workflow/config changes to the source ref, enable the sideload gate,
   then dispatch **Mobile sideload binaries** with `ref` and `version` (without
   `v`). Leave `release_tag` blank for staging Actions artifacts. Verify on actual
   phones, including a two-version Android upgrade and iOS signing/refresh.
4. Stable/preview `release.yml` runs include `Paperplane-<version>.apk` and
   `Paperplane-<version>-unsigned.ipa` in the same GitHub Release and `SHA256SUMS`.
   For manual attachment, supply an **existing** `release_tag`; this uploads the
   binaries and a separate `MOBILE-SHA256SUMS` without replacing desktop checksums.
   It refuses existing asset names rather than silently replacing a published key
   or build. Build-only runs upload Actions artifacts without publishing.

Both platforms use the numeric part of the release version as `PAPERPLANE_MOBILE_VERSION`
(iOS rejects prerelease suffixes; file names keep the full version) and
`PAPERPLANE_MOBILE_BUILD_NUMBER` (seconds since 2020, generated at workflow preparation)
for native build numbering across workflows. Re-running failed jobs reuses the
preparation job's number; a new run generates a new one. Do not publish concurrent
manual builds out of order or dispatch builds within the same second.

The unsigned device archive uses `PAPERPLANE_IOS_UNSIGNED=1` with
`PAPERPLANE_IOS_PERSONAL_TEAM=1`; the unsigned mode defaults its bundle ID to
`io.github.getpaperplane.paperplane`. It strips push, App Groups, Sign in with Apple, widgets, the share
extension, and explicit keychain groups. Sideload signers supply their own default
keychain group; changing signing identity/bundle ID can lose access to saved
credentials. Normal signed builds retain their keychain entitlement. An unsigned
IPA is not directly installable: users re-sign it with their own Apple ID. Test
LiveContainer separately; its container execution is not equivalent to a normal
iOS installation. No full native build or device test is implied by config tests.

## Build self-signed macOS artifacts without Apple membership

This mode signs desktop and CLI artifacts with your own certificate. It does not provide Apple notarization or Apple-provisioned native passkeys. Users must approve the initial unnotarized installation. Do not enable `PAPERPLANE_MACOS_SIGNING_READY` for this mode. That variable controls the separate Apple-signed PR preview workflow.

1. Create a new self-signed Code Signing identity named `Paperplane Release Signing` in Keychain Access. Export the certificate and private key as a password-protected `.p12`. Keep an encrypted backup of the identity and its password. Use the same identity for every release.
2. Add the Base64-encoded `.p12` as the repository Actions secret `CSC_LINK`. Add its export password as `CSC_KEY_PASSWORD`. Do not put either value in source control or logs.
3. Add the repository Actions variable `MACOS_SIGNING_MODE` with value `self-signed`. The default certificate name is `Paperplane Release Signing`. If you chose another name, set `MACOS_SIGNING_IDENTITY` to that exact name.
4. Push the workflow and signing scripts to the ref you want to build. Dispatch `release.yml` with `channel=preview` and `build_only=true`. Keep publication disabled during verification.
5. Check the macOS job for successful identity import and packaged-app signature verification. Download its desktop and CLI artifacts. Follow the job summary's first-install guidance only for artifacts you trust.
6. Test installation and a two-version auto-update on a Mac that does not have your certificate installed. Use an update feed configured before signing the test builds. Confirm that a same-certificate update installs and relaunches, and that a different-certificate update fails. Do not treat CI signature verification as proof that auto-update works.

Unsigned or differently signed installations may require a one-time manual reinstall before they can follow the new signing identity. Losing or replacing the certificate can break update continuity.

## Build self-signed Windows artifacts without Azure

Windows self-signing is free. It does not provide public certificate trust or remove SmartScreen warnings. Users must trust the public certificate before signature-checked updates can install. Keep update signature verification enabled.

1. On macOS or Linux with OpenSSL 3, create the identity outside the repository:

   ```sh
   printf 'Certificate password: '
   read -r -s PAPERPLANE_CERTIFICATE_PASSWORD
   printf '\n'
   export PAPERPLANE_CERTIFICATE_PASSWORD
   bash scripts/create-windows-signing.sh "$HOME/.config/paperplane-release-signing/windows"
   ```

2. Back up the `.pfx` and its password securely. Reuse this identity for every release. Replacing it requires users to trust the new certificate.
3. Set separate Windows Actions secrets and enable the mode:

   ```sh
   base64 < "$HOME/.config/paperplane-release-signing/windows/paperplane-windows-signing.pfx" | gh secret set WIN_CSC_LINK
   printf '%s' "$PAPERPLANE_CERTIFICATE_PASSWORD" | gh secret set WIN_CSC_KEY_PASSWORD
   gh variable set WINDOWS_SIGNING_MODE --body self-signed
   unset PAPERPLANE_CERTIFICATE_PASSWORD
   ```

4. Run a build-only preview. Check both Windows jobs for successful signing and signature verification. The public `paperplane-windows-signing.cer` is included with the installers and CLI archives. The private `.pfx` is never published.
5. Test installation and a two-version update on Windows with the certificate trusted. Confirm that a changed payload or different signing certificate fails verification.

CI runs native signing tests and updater, schema, and preview checks on Windows x64 and arm64. The broader Windows suite remains manual. These checks do not replace an installed-app upgrade test. Leave `WINDOWS_SIGNING_MODE` unset to retain the existing Azure signing path.

## First npm publication (free)

The `@getpaperplane` organization must own the launcher and all five platform packages. npm trusted publishers are configured per package, after its initial publication; creating the organization alone does not enable OIDC publishing.

1. Merge the workflow to `main`, then dispatch a non-publishing preview build:

   ```sh
   gh workflow run release.yml --ref main -f channel=preview -F build_only=true
   ```

2. After quality checks and all platform builds pass, download the `npm-packages` artifact from that run. It contains `cli.tgz` and five `cli-<platform>.tgz` tarballs. Inspect their manifests and test the accompanying desktop and CLI artifacts before publishing. Do not bootstrap from placeholder packages or a stable-version build: use the generated preview version so `0.0.1` remains available.
3. As a maintainer, log in with `npm login` (with account 2FA enabled), then publish the inspected platform tarballs first and launcher last from the extracted artifact directory:

   ```sh
   for package in cli-*.tgz; do
     npm publish "$package" --access public --tag preview || exit 1
   done
   npm publish cli.tgz --access public --tag preview
   ```

   This is a real public publication, not a validation step. No npm token belongs in GitHub secrets. A local initial publication does not use GitHub OIDC provenance.

4. In each package's npm settings, add a GitHub Actions trusted publisher: owner `getpaperplane`, repository `paperplane`, workflow `release.yml`, environment blank. Configure all six packages: `@getpaperplane/cli`, `@getpaperplane/cli-darwin-arm64`, `@getpaperplane/cli-linux-x64`, `@getpaperplane/cli-linux-arm64`, `@getpaperplane/cli-win32-x64`, and `@getpaperplane/cli-win32-arm64`.
5. After staging approval, enable `PAPERPLANE_RELEASE_READY` and explicitly dispatch `channel=nightly`, `build_only=false`. A fresh run generates a new prerelease version instead of attempting to overwrite the bootstrap version. Verify that release before dispatching stable with `version=0.0.1`, `build_only=false`. Stable builds the latest published nightly commit, not the current branch, even with a version override.

Finalization uses a GitHub App installed on this repository with Contents write permission. Store its App ID and PEM key as `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY`; branch rules must permit its version-bump commit. npm publishing and finalization have no extra readiness switches.
