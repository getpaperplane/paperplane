# Remote access

Paperplane releases support local, LAN, Tailscale, SSH, and the hosted browser app at [paperplane.hafiezulzikry.com](https://paperplane.hafiezulzikry.com). Paperplane Connect is disabled unless a maintainer configures the cloud deployment; its instructions below apply only to those builds. Mobile clients are available as sideloadable APK/IPA downloads on supported [GitHub Releases](https://github.com/getpaperplane/paperplane/releases), or as source builds, not store apps. The phone is a client: its desktop or `paperplane serve` host must remain running and reachable over LAN, Tailscale, or SSH. See [mobile installation](./install.md#mobile-app).

Connect a phone, browser, or another desktop app to Paperplane running on a different
machine. That machine must stay running and reachable while you work.

## Paperplane Connect

Paperplane Connect makes an environment available to your other devices without setting
up router forwarding. In the desktop app on the host, open **Settings →
Connections**, sign in, and enable **Paperplane Connect** for that environment.

For a command-line host, run:

```bash
paperplane connect
```

Follow the sign-in instructions. Setup offers a
[background service](./background-service.md); if you decline it, start the
server with `paperplane serve`. Saving your sign-in alone does not make the machine
reachable.

On your other device, sign in to the same Paperplane Connect account and choose the
environment. Over SSH, the CLI prints a browser link and a short code. Open the
link on any device, confirm the code matches, and approve. The CLI continues on
its own, so you do not need to forward an OAuth callback port.

Paperplane Connect renews access credentials when needed without disconnecting a healthy
connection. Pull request diffs and provider settings keep working after the
previous credential expires. A failed renewal affects that request; it does not
disconnect an otherwise healthy conversation.

## Hosted browser app

Pair [paperplane.hafiezulzikry.com](https://paperplane.hafiezulzikry.com) with a reachable HTTPS host, such as Tailscale HTTPS or an operator-managed Cloudflare Tunnel. A public HTTPS app cannot connect to a plain HTTP LAN endpoint. A loopback URL refers to the device opening it, not the remote host.

## Pair over a LAN or private network

Use direct pairing when the other device can reach the host's network address.

On a desktop host, open **Settings → Connections**, enable **Network access**,
then create a pairing link using an address the other device can reach. Changing
network access restarts the desktop app. You can turn it off in the same place.

For a persistent command-line host, use `paperplane service install --host <private-ip> --port 3773`, then `paperplane pair`. Its connection settings survive restarts and updates; the machine must stay awake.

For a command-line host started by hand, replace `<private-ip>` with the host's LAN or tailnet
address:

```bash
paperplane serve --host <private-ip>
```

If a server is already running, generate a fresh link without restarting it:

```bash
paperplane pair
```

Scan the QR code on your phone or paste the pairing URL into **Add environment**
in the receiving app. Connection settings are under **Settings → Connections**
on web and desktop and **Settings → Environments** on mobile. A loopback address
such as `127.0.0.1` reaches only the device opening the link.

Pairing authorizes that device for future connections. Use a fresh one-time link
for each new device; you do not need the original token to reconnect. Links
created in Settings can only be copied from the client that created them while
its Connections page stays open. If you leave or reload that page, create
another link to share.

### Reach one machine several ways

A machine can have more than one route: LAN, Tailscale, another VPN, a public
URL, SSH, or Paperplane Connect. Tailscale shares its `100.64.0.0/10` address range with
other VPNs such as Cloudflare WARP, so an address in that range shows as VPN
unless the machine confirms it is on Tailscale. To add a route, choose **Add
route** in the machine's route list, or next to it in the Paperplane Connect list.
Pairing the same machine again over another address also adds a route instead
of a second machine. A new route is placed by speed, in that order, and you can
reorder routes at any time.

While connected through Paperplane Connect or a paired address, Paperplane also learns the
machine's current LAN and Tailscale addresses and adds them as routes, so
pairing once through Paperplane Connect is enough to use the LAN at home. When the
machine's LAN address changes, for example after it joins another Wi-Fi network,
the learned route follows it. The machine must allow network access for its LAN
address to be learned. You can reorder a learned route, but not remove it; it
goes away with the route it was learned through, or when the machine stops
reporting that address.

Paperplane connects over the first route that answers. Away from home, a LAN
address that does not answer is checked briefly and skipped. It is only tried
again, after the other routes, if none of them connect. While connected over a
later route, Paperplane checks the earlier ones when your network changes, when you
return to the app, and every minute, and moves back as soon as one works.

On web and desktop, select the route count under the machine's name in
**Settings → Connections** to see its routes. Drag a route to change the order,
or remove it. On mobile, open the machine under **Settings → Environments** and
choose **Edit**. Signing out of Paperplane Connect removes only that route; a machine
you can still reach another way stays saved.

Open **Permissions** next to **Routes** in web or desktop, or **Your permissions**
in the mobile route details, to see what your current connection can do on that
environment. For a remote environment, this is in its route details. Permissions
shown there apply only to the route marked **In use**; other routes are not
checked. Direct pairing and Paperplane Connect have separate sessions and may grant
different permissions.

### Balance new threads across machines

Auto balance is off by default. On web and desktop, enable it in
**Settings → Connections → Load balancing** to automatically choose a machine for
new threads in projects grouped across connected environments. The section
appears once two or more machines are switched on.
Each machine starts at **Normal**. Choose **Prefer** to favor it when it has CPU and
memory available, **Less often** to reduce its share, or **Manual only** to exclude
it from automatic selection. These are preferences, not fixed traffic percentages.
Preferences are saved separately in each client.

The composer checks eligible machines when choosing a draft's environment, then keeps
that choice stable. Choose **Auto balance** again to check current resources, or choose
a specific machine to override it. Choosing a branch or worktree also keeps the draft
on that machine. Existing threads stay where they started. If resource checks are
unavailable or all eligible machines are full, choose a machine manually to continue.
Mobile keeps its manual environment selection.

### Tailscale HTTPS

Join both devices to the same tailnet. In the desktop app, enable **Tailscale
HTTPS** in **Settings → Connections**. Turn it off there to remove that route.

To start a command-line server with Tailscale HTTPS:

```bash
paperplane serve --tailscale-serve
```

For an already-running server:

```bash
paperplane pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`.
The mapping created by `pair --tailscale` persists across restarts. Remove its
default-port mapping with:

```bash
tailscale serve --https=443 off
```

Both devices must belong to the tailnet. Tailscale must run where the server and its loopback endpoint are reachable; installing it on Windows alone does not establish that WSL owns the Windows Tailscale address.

If that port is already in use, choose another with
`--tailscale-serve-port`. See `paperplane pair --help` for other pairing options.

### Direct HTTP connections

A hosted HTTPS browser app connects directly to your server; a hosted pairing link does not make an unreachable backend reachable or convert HTTP to HTTPS.

For a plain HTTP LAN endpoint, use the direct pairing URL in a browser that can
open it, or pair from the desktop app. On mobile, an IP address entered without a
scheme uses HTTP, so include `https://` when your server uses HTTPS.

## Small or WSL hosts

On hosts with 8 GB of RAM or less, Paperplane releases idle agent processes after 5 minutes
instead of 30, and frees idle agents before starting a new one when memory runs low. A
released thread resumes on its next message. When available memory is low, the
composer shows a notice. On web and desktop, Settings → Diagnostics shows host
memory health and suggested fixes; on mobile, open the environment's detail screen
in Settings. Run `paperplane doctor` on the host for the same checks without connecting a client.
An agent that exited with SIGKILL while the host recorded an out-of-memory kill may
be labeled **"Likely killed: the host ran out of memory."** Only SIGKILLed agents
get this likely label; it is a diagnosis, not proof that memory caused that particular kill.

WSL uses half of Windows RAM by default. To give it a fixed budget, set these under `[wsl2]`
in `%UserProfile%\.wslconfig`, then run `wsl --shutdown`:

```ini
[wsl2]
memory=6GB
swap=4GB
autoMemoryReclaim=gradual
```

Enable systemd in WSL by adding `systemd=true` under `[boot]` in `/etc/wsl.conf`, run
`wsl --shutdown`, then run `loginctl enable-linger $USER` inside WSL. With systemd, Paperplane
Code can contain agent memory and label out-of-memory kills. See [background hosting](./background-service.md#platform-support).

To reduce background work, choose **Battery saver** in **Settings → General → Background
activity**. It turns off automatic Git fetch and checks providers less often. Codex runs one
process per provider instead of one per thread, so it is lighter on small hosts.

## Desktop-managed SSH

In the desktop app, open **Settings → Connections → Add environment**, choose
**SSH**, and enter a host or SSH alias such as `user@example.com`. Paperplane starts
or reuses a server there and opens the port forward for you. Projects, provider
credentials, and agent work stay on the remote machine.

The remote host must be Linux or an Apple Silicon Mac with `curl` or `wget`,
`tar`, `sha256sum` or `shasum`, and [provider setup](./install.md#providers).
When upgrading an SSH or WSL host from Rove Code, stop its old background service or
`paperplane serve` terminal on that host, then reconnect. Paperplane does not kill old remote
processes automatically. A held old-home lock reports the platform's stop command;
[background service upgrade instructions](./background-service.md#upgrading-from-paperplane-code)
cover service-managed hosts. Old runtime caches and launch scripts are not reused.

The first launch downloads Paperplane's server to `~/.paperplane/runtime` on the host, so
it takes longer than later ones.
Provider CLIs must be on the `PATH` of a non-interactive login shell there;
check with:

```bash
ssh user@example.com 'sh -lc "command -v claude codex"'
```

If SSH reconnecting fails after an app update, retry the launch once. Removing
the connection closes its port forward but leaves the remote host's persistent
service running. Stop or uninstall the service on that host when you no longer
need it; see [Running in the background](./background-service.md).

For Antigravity's Google callback on a remote host, see
[remote sign-in](./providers-antigravity.md#sign-in-from-a-remote-device).

## Remote sandboxes (preview)

On web and desktop, open **Settings → Integrations → Remote sandboxes**. Sandboxes belong to the primary environment unless you select another one. On mobile, open **Settings → Environments**, select the managing environment, and use **Remote sandboxes**. Administrative access to that environment is required.

Add your own Boat API key or Modal token ID and secret. Credentials stay on the managing environment. Saving checks them with the vendor but does not start compute. Creating or resuming a sandbox starts billing on your infrastructure account. Free credits, storage charges, and retention depend on the vendor. Boat requires trial/subscription checkout before starting compute. Paperplane currently requests unlimited runtime, which Boat trial accounts do not support; use a paid Boat plan or Modal instead.

Choose **Forward sign-ins** to copy your Codex, Claude, Pi, OpenCode, or GitHub sign-in from the managing environment into the sandbox, so agents there use your existing subscriptions. Paperplane installs the matching command-line tool in the sandbox and copies fresh sign-ins on every resume. Clearing a checkbox removes that sign-in from the sandbox. Anyone with access to the sandbox can use forwarded sign-ins. Claude and Pi refresh their sign-ins independently on each machine; if one machine is signed out, sign in again there and forward again.

Modal sandboxes run wherever Modal has capacity unless you pick a region when creating one. Pinning a region costs 1.15 times Modal's base price, and you can't change it later. Distance to the sandbox adds delay to every click and keystroke.

**Settling a thread does not stop billing in this preview.** Pause its sandbox manually after work finishes. Pausing interrupts running agents, builds, and terminals; resuming restores files and persisted conversations, not running processes. Modal ends each run after 24 hours, and changes made since the last pause are lost, so pause before then. Boat retention is governed by your account's policy. A paused environment is offline, including its transcripts, until resumed.

The managing environment must be online for lifecycle controls. Explicit deletion removes the remote workspace and recovery data irreversibly; removing a client connection does not delete or pause compute. If provisioning fails without a resource ID, check the vendor dashboard for orphaned resources before deleting the saved failure record. If credentials expire or vendor-side cleanup prevents deletion through Paperplane, clean up in the vendor dashboard, then forget the failed record. Forgetting removes only Paperplane's tracking and recovery handles; it does not stop billing.

## Browser on a remote environment

Browser tabs belong to the environment, so you and your agents see the same
tabs from any device. The desktop app shows its own environment's tabs
directly. Every other device, and the desktop app for other environments,
streams them from the host. Agents keep using them while no device is
connected, and `localhost` addresses reach servers on the host.

The first tab downloads a headless Chrome, about 120 MB, into the Paperplane home. It
is the same browser [HTML renders](html-renders.md) use, so a host downloads it
only once. Some Linux hosts need [setup](#browser-host-setup) before it can
start.

Agent tabs have separate storage and share a Chromium process. Take control before
typing into an agent's tab, then release control when you want the agent to
continue. Read-only connections can watch without changing the page.

While you have control, the tab works with your device: text the page copies or
cuts goes to your clipboard, a file picker on the page opens your device's
picker, and a finished download is offered for you to save. Popups such as
sign-in windows open as their own tabs. Downloads stay on the host until the
tab closes. Audio does not play on your device.

On a phone, tap the floating preview's corner dot to show its controls, then
**Pop into separate window** to keep watching in picture-in-picture over other
apps.

### Browser host setup

macOS, Windows, and Linux desktops run the browser as is. Some Linux hosts need
one-time setup: Ubuntu 23.10 and later block the sandbox the browser runs in,
and minimal images and containers lack libraries it loads. When that happens,
the server says so at startup, and browser tabs and HTML previews show the
command to run on the host:

```sh
sudo paperplane browser setup
```

The server shows the exact line for how you started it, such as
`sudo npx @getpaperplane/cli browser setup`, and keeps your `PATH` when Node is installed only
for your user. Where `paperplane` is not on your `PATH`, such as with only the
desktop app installed, it names the full path of the app's own `paperplane` instead. It allows Chrome's sandbox with an AppArmor profile and installs
any missing libraries with apt. It is safe to run again. Without `sudo`, it
only reports what it would change. Setup replaces an unmodified old
`paperplane-chrome-headless-shell` AppArmor profile and carries its `local/` overrides
to `paperplane-chrome-headless-shell`. Customized profiles are left for manual
review; conflicting local overrides must be merged before retrying.

The browser always runs in Chrome's sandbox. Where you cannot change the host,
set `PAPERPLANE_SERVER_BROWSER_SANDBOX=0` for the environment to run without it.

## Connect an outside agent

Claude Code, Codex, ChatGPT and other agents Paperplane did not start can drive
threads on an environment through its MCP server. See
[outside agents](./outside-agents.md) for setup.

## Manage or revoke access

On the host, **Settings → Connections** lets authorized administrators create
pairing links and revoke client sessions. Revoking an unused link prevents new
pairings; revoke a device's session to remove its existing access. Command-line
management is available through `paperplane auth --help`.

A session with an open connection stays listed after its access credential
expires.

To choose a token's permissions, pass `--scope` once for each scope you want:

```sh
npx @getpaperplane/cli pair --scope orchestration:read --scope relay:read
```

The selected scopes replace the default permissions. The same option works with
`npx @getpaperplane/cli auth pairing create` and `npx @getpaperplane/cli auth session issue`; each command's
`--help` lists the available scopes. Without `--scope`, pairing tokens retain
standard client permissions and issued bearer sessions retain administrative
permissions.

To change an existing client's permissions, create a fresh pairing link with the
scopes it needs. In a browser opened directly on the environment, open that link
to replace the browser's current grant. For mobile or a saved remote environment
in web or desktop, use **Add Environment** with the fresh link or code; pairing
the same environment replaces its saved grant. Reconnecting alone does not change
permissions.

Grouping checkouts does not combine their permissions. Shared project settings
require `orchestration:operate` on every member environment; actions on one
checkout use that checkout's permissions.

`source-control:write` covers direct Git and pull request changes made from the
client: pushing, switching or creating branches, cloning, and removing
worktrees. It does not restrict what a task does. Starting a task in a new
worktree still creates that branch and worktree with `orchestration:operate`,
and the agent it runs can use Git however the environment allows.

Settings changes, provider management, and environment maintenance can be granted
separately from access administration. New standard pairings include these
permissions. Existing clients can stay connected after an update, but newly separated
features may require pairing again with the permissions they need. Older clients
may show controls that the server denies. Create a fresh pairing link to change
a client's permissions.

`filesystem:read` allows browsing host files, opening workspace files, and viewing
local changes. Add `filesystem:write` to allow editing files or saving plans to
the workspace. These scopes control direct file access from the client.

To remove an environment from Paperplane Connect, open your account menu's **Paperplane Connect**
page, or **Settings → Paperplane Connect** on mobile, and choose **Deregister**. This
revokes its cloud access and frees its host space even when the environment is
offline or has been wiped. When Paperplane Connect rejects a host's link, the host
shows that it was removed from Paperplane Connect. To link it again, turn on
**Paperplane Connect** in **Settings → Connections** on a desktop host, or run
`paperplane connect link` on a command-line host and then restart Paperplane there. A
command-line host that released its tunnel when it last stopped may link itself
again on its next start; run `paperplane connect unlink` on that host to keep it off.
Removing an environment from a device's connection settings only forgets it on
that device; it stays registered to your account.

When idle tunnel cleanup is enabled, Paperplane Connect removes a linked environment's
tunnel after it stays offline for several minutes. The environment stays linked
and keeps the same address. When the host starts again or wakes, Paperplane Connect
creates a replacement tunnel on its own. You do not need to pair again. Cleanup
usually runs five to ten minutes after the tunnel goes down.

Paperplane Connect also removes the tunnel of an environment running an older version of
Paperplane once it has been offline for seven days. That environment shows a message
asking you to update. Start Paperplane on that computer and update it to the latest
version; it reconnects at the same address without pairing again.

On a command-line host, `paperplane connect unlink` disables exposure while retaining
your login; `paperplane connect logout` also clears that login. Background-service
[removal](./background-service.md#manage-the-service) is separate.

Treat pairing URLs and authorization codes as passwords. Do not include them in
screenshots, logs, or bug reports.

## Paperplane Connect troubleshooting

Run `paperplane connect status` on the host to inspect saved authorization and link
configuration. It is not a live reachability check. If the environment appears
offline, run `paperplane service status` and read the displayed log. If it disappears
when SSH closes, see [background-service troubleshooting](./background-service.md#troubleshooting).

| Error                                                     | Recovery                                                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment_link_limit_exceeded` or managed tunnel limit | Deregister an unused environment, then restart Paperplane on the host.                                                                                              |
| `auth_invalid` or `invalid_bearer`                        | Run `paperplane connect login`. If credentials were revoked, run `paperplane connect logout`, then `paperplane connect` again. Restart the server after signing in. |
| Expired or invalid link proof                             | Check the host's date and time, update Paperplane, then restart it.                                                                                                 |
| HTTP 403 without a recognized error                       | Check relay access, proxies, and firewall rules. Keep any Cloudflare Ray ID for a bug report.                                                                       |
| HTTP 408, 429, or 5xx                                     | Check network and relay availability. Startup retries temporary failures for up to ten minutes.                                                                     |

After fixing a permanent rejection, restart the host's server. On Linux, use
`systemctl --user restart paperplane.service` for the background service. For a
foreground server, stop it and run `paperplane serve` again with your usual options.
Include the diagnostic message and trace ID when reporting a persistent failure.

For a connection that still fails after linking, check the date and time on both
devices. For server version warnings, follow [Updating Paperplane](./updating.md).

## Using the Desktop App as a Remote Only

If a computer should only drive work running elsewhere, turn off its local environment. In the
desktop app, open **Settings → Connections** and switch off **Local
environment**. Paperplane restarts without a local server: no local agents or terminals run, WSL
backends stay off, and other devices can no longer connect to this computer. Your projects,
history, and saved connections are kept, and you keep working through pairing, Paperplane Connect, or SSH.

Switch **Local environment** back on in the same place to restart with your previous local
settings.
