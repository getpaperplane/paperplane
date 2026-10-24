# Install Paperplane

Download desktop installers from [Paperplane releases](https://github.com/hafiezul/rove/releases).
Use Paperplane-owned CLI packages. Do not substitute an upstream package.

## Command line

With Node.js and npm available for installation, run:

```sh
npm install -g @getpaperplane/cli
paperplane service install
paperplane service status
```

The npm package contains the platform executable. Service installation places
an exact-version runtime outside npm's cache. The running service does not
require a Git checkout or a system Node.js installation.

To bootstrap without a global npm installation, run:

```sh
npx @getpaperplane/cli@latest service install --tailscale-serve
npx @getpaperplane/cli@latest pair --tailscale
```

Use the pairing URL in **Settings → Connections → Add environment** on your
client. Tailscale must run on the host and receiving device. See
[remote access](./remote-access.md) for direct LAN, SSH, and browser connections.

Persistent CLI hosts support Linux x64 and arm64, including systemd-enabled WSL,
and Apple Silicon macOS with launchd. Intel macOS CLI archives and native Windows
background services are not supported. Desktop clients have a separate platform matrix. See [background hosting](./background-service.md)
for prerequisites, restart, and removal.

Update a packaged host with `paperplane update`, or
`npx @getpaperplane/cli@latest update`. See [updates](./updating.md).

Contributor source setup lives in the [development guide](../operations/development.md).
It is not the installation or update procedure for a persistent host.

Outside a development worktree, Paperplane uses `~/.paperplane` for its data.
On first start, Paperplane copies an existing `~/.rove-code` install and keeps the old folder as a backup. Quit Rove Code and stop its background service before starting Paperplane. An explicit `--home-dir` or `PAPERPLANE_HOME` skips this copy.
Downloaded runtimes and CLI shims do not block the copy. If `~/.paperplane/userdata` already exists, Paperplane keeps it and records that the old home was not migrated in `~/.paperplane/home-migration.json`.
Importing data from another installation is not yet supported.

## Desktop command line

The desktop app includes the `paperplane` command. In **Settings → General → About**, choose **Install** next to **paperplane command**, then open a new terminal. **Remove** takes it off your PATH again. On upgrade, old desktop-owned `rove` launchers are removed only when their exact ownership marker matches. On Windows, choose **Install** again to replace the old desktop PATH entry.

Existing npm installations stay unchanged: after installing Paperplane, run `npm uninstall -g @rove-code/cli` yourself. Old standalone-installer `rove` links and manually added shell-profile lines are left alone; remove them yourself if no longer needed. The installers do not edit shell profiles, and their default `~/.local/bin` PATH entry is still used by Paperplane.

With the desktop app running, `paperplane app` opens a new thread for the current directory. Pass a path, such as `paperplane app ../my-project`, to use another directory. This requires the desktop app; a standalone server or SSH session is not enough.

## Test an unsigned macOS build

If you are testing an **unsigned** macOS DMG from this repository's build
artifacts, macOS may say the app is "damaged" after you copy it to Applications.
Only if you trust the artifact you downloaded, remove the download quarantine
for that app:

```sh
xattr -dr com.apple.quarantine "/Applications/Paperplane (Alpha).app"
```

For a nightly build, use `/Applications/Paperplane (Nightly).app` instead. This
bypasses Gatekeeper's download check for that app; it does not verify the app is
safe. Do not disable Gatekeeper system-wide. If you do not trust the artifact,
do not run this command.

## Trust a self-signed Windows build

Self-signed Windows releases include `rove-windows-signing.cer`. They are not publicly trusted, and SmartScreen warnings can remain.

Only if you trust this repository's release, compare the certificate's SHA256 fingerprint with the release build summary:

```powershell
certutil -hashfile .\rove-windows-signing.cer SHA256
```

After confirming the fingerprint, trust the certificate for your Windows account:

```powershell
Import-Certificate -FilePath .\rove-windows-signing.cer -CertStoreLocation Cert:\CurrentUser\Root
Import-Certificate -FilePath .\rove-windows-signing.cer -CertStoreLocation Cert:\CurrentUser\TrustedPublisher
```

This trusts code signed by that certificate. Do not import a certificate from an untrusted download. Paperplane keeps signature verification enabled for updates. An older unsigned installation may need one manual reinstall before following signed updates.

To remove that trust, use `certmgr.msc` to remove the same certificate from **Trusted Root Certification Authorities** and **Trusted Publishers**. Updates signed by it then fail verification.

## Mobile app

Upgrading from Rove Code requires a fresh mobile installation and pairing again.
Paperplane has new iOS and Android identities (`io.github.getpaperplane.paperplane`,
with `.dev` and `.preview` variants), so it cannot update the old app in place.
Remove the old app when you no longer need its local settings; host conversations
remain on your server.

Download `Rove-Code-<version>.apk` (Android) or
`Rove-Code-<version>-unsigned.ipa` (iOS) from the
[GitHub Release assets](https://github.com/hafiezul/rove/releases) when available.
Mobile binaries accompany stable and preview releases, not daily nightlies.
There are no App Store or Google Play releases from this project.

- **Android:** open the APK on your phone and allow **Install unknown apps** for
  the browser or file manager you use. Install future APKs over the existing app
  to keep your settings; they must come from the same signing key.
- **iOS:** the unsigned IPA cannot be installed directly. Import it into AltStore,
  SideStore, or Sideloadly and sign it with your free Apple ID, or import it into
  an already installed LiveContainer. Free Apple ID provisioning normally needs
  re-signing every 7 days and allows 3 active sideloaded apps. LiveContainer has
  its own compatibility and setup requirements; importing an IPA there is not a
  guarantee it will run. No paid Apple membership is needed.

The iOS sideload build omits push notifications, widgets, and the share extension.
Android push notifications need Firebase configuration and Paperplane Connect, neither
of which is included in these downloads.

**The phone is a client, not an agent host.** The host machine running the desktop
app or `paperplane serve` must stay running and reachable over LAN, Tailscale, or SSH.
Pair it using [remote access](./remote-access.md#pair-over-a-lan-or-private-network).
For source builds, see `apps/mobile/README.md`.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Pi          | Paperplane embeds Pi through its SDK. Authenticate Pi on the server and enable it in provider settings; see [Pi](./providers-pi.md).                      |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |
| Antigravity | Install and sign in with Google from Paperplane's provider settings.                                                                                      |

Provider CLIs must be on the server's `PATH`. If Paperplane cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

Paperplane warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** appears only when Paperplane can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, Paperplane does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), and
[Antigravity](./providers-antigravity.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating Paperplane](./updating.md): update the app and connected servers.
