# Connect to another environment

Each environment owns its repositories, provider credentials, and thread history. Desktop and web clients can connect to several environments at once. Install and authenticate your coding agents on each host.

Packaged hosting requires a published Rove CLI release or a staged release candidate. Do not use an upstream package to install this fork.

## Add a persistent CLI host

Install the CLI following [installation](./install.md), then install its [background service](./background-service.md). On a private tailnet, run:

```sh
rove service install --tailscale-serve
rove pair --tailscale
```

Both devices must belong to the tailnet. Tailscale must run where the server and its loopback endpoint are reachable. Installing Tailscale only on Windows does not establish that a WSL distribution owns the Windows Tailscale address.

For direct LAN or tailnet access, bind to an address available on the host:

```sh
rove service install --host <private-ip> --port 3773
rove pair
```

On the receiving client, open **Settings → Connections → Add environment** and use the pairing URL. Create a separate one-time link for each client. Pairing expires, but a paired client's saved session allows it to reconnect without the original link.

The service retains its connection settings across restarts and updates. Keep the machine and, for WSL, the distribution running. A sleeping host is offline.

## Add a host through desktop SSH

In the desktop app, add an SSH environment using a host or SSH alias your computer can reach. Tailscale SSH addresses use the same path.

Rove downloads its exact-version CLI archive and installs a persistent host service if needed. An existing service is reused, or restarted if stopped. Disconnecting or removing the saved SSH connection closes the local forward, not the host service. Update the host through its connection row or `rove update`.

Linux hosts require systemd and user-service prerequisites. macOS requires an available graphical login session for its launch agent. SSH requires the server to be reachable on the host's loopback interface. A browser cannot provision a host through SSH. It can pair with that host through a reachable HTTPS endpoint.

## Share a desktop host

On the desktop host, open **Settings → Connections**, enable **Network access**, and create a pairing link using an address the other device can reach. Turning network access off removes that route. The desktop application must stay running because it supervises the environment.

## Use a hosted browser app

Open the hosted app and add each environment under **Settings → Connections**. The app connects directly to the backend. It does not run agents or proxy environment traffic.

Use a reachable HTTPS backend, such as Tailscale HTTPS or an operator-managed Cloudflare Tunnel. A plain HTTP LAN endpoint does not work from a public HTTPS app. A loopback URL refers to the device opening it, not the remote host.

## Run a thread in a remote sandbox (preview)

On web and desktop, open **Settings → Integrations → Remote sandboxes**. Sandboxes belong to the primary environment unless you select another one. On mobile, open **Settings → Environments**, select the managing environment, and use **Remote sandboxes**. Administrative access to that environment is required.

Add your own Boat API key or Modal token ID and secret. Credentials stay on the managing environment. Saving checks them with the vendor but does not start compute. Creating or resuming a sandbox starts billing on your infrastructure account. Free credits, storage charges, and retention depend on the vendor. Boat requires trial/subscription checkout before starting compute. Rove currently requests unlimited runtime, which Boat trial accounts do not support; use a paid Boat plan or Modal instead.

Choose **Forward sign-ins** to copy your Codex, Claude, Pi, OpenCode, or GitHub sign-in from the managing environment into the sandbox, so agents there use your existing subscriptions. Rove installs the matching command-line tool in the sandbox and copies fresh sign-ins on every resume. Clearing a checkbox removes that sign-in from the sandbox. Anyone with access to the sandbox can use forwarded sign-ins. Claude and Pi refresh their sign-ins independently on each machine; if one machine is signed out, sign in again there and forward again.

Connect once to add the sandbox to this client. After that, a project with a Git remote can pick the sandbox under **Run on** in a new thread; Rove clones the repository into the sandbox and starts the thread there once the clone finishes. GitHub repositories clone over HTTPS with the forwarded GitHub sign-in. Local changes that aren't pushed aren't copied. Agent execution can continue after your client disconnects. Linux sandboxes do not replace a Mac for Xcode builds.

Modal sandboxes run wherever Modal has capacity unless you pick a region when creating one. Pinning a region costs 1.15 times Modal's base price, and you can't change it later. Distance to the sandbox adds delay to every click and keystroke.

**Settling a thread does not stop billing in this preview.** Pause its sandbox manually after work finishes. Pausing interrupts running agents, builds, and terminals; resuming restores files and persisted conversations, not running processes. Modal ends each run after 24 hours, and changes made since the last pause are lost, so pause before then. Boat retention is governed by your account's policy. A paused environment is offline, including its transcripts, until resumed.

The managing environment must be online for lifecycle controls. Explicit deletion removes the remote workspace and recovery data irreversibly; removing a client connection does not delete or pause compute. If provisioning fails without a resource ID, check the vendor dashboard for orphaned resources before deleting the saved failure record. If credentials expire or vendor-side cleanup prevents deletion through Rove, clean up in the vendor dashboard, then forget the failed record. Forgetting removes only Rove's tracking and recovery handles; it does not stop billing.

## Use configured Rove Connect

Rove Connect links an environment to a cloud account and manages its tunnel. It is available only in builds configured for an operator's Clerk instance and relay. Direct pairing, Tailscale, and SSH do not require it.

Connect does not replace host installation or updates. Keep the host's background service installed and use `rove update` for its runtime. Operators configure cloud deployment using the [Connect setup procedure](../operations/connect-setup.md).

## Balance new threads across hosts

On web and desktop, **Settings → Connections → Load balancing** appears when two or more machines are connected. Set a machine to **Prefer**, **Less often**, or **Manual only** to influence new-thread placement. Existing threads remain on their original environment. Mobile selects a machine manually.

Clone the repository and authenticate an eligible provider on each machine before balancing work across them. Project grouping does not synchronize files between machines.

## Continue a thread on another machine

On web and desktop, open a project thread's menu and choose **Continue on**, then the machine. On mobile, use the thread's menu or **Continue on another machine** in the chat. Both machines need an up-to-date Rove Code host and their own clone of the repository with the same remote.

Wait for the source thread and its background work to finish, then commit and push any remaining changes. Rove Code verifies the published branch and commit before opening a continuation draft. The destination checks out that exact commit in a new worktree; an existing branch at a different commit is not reset.

Review the draft's transferred context and edit the request before sending. It includes intact selected messages, the original request when it fits, and recent work state. The review shows omitted history and attachments; additional imported items remain readable by the destination agent even when the source is offline. If history cannot be loaded, retry or explicitly choose **Continue with code only**.

Drafts survive reloads. Once sent, the threads link to each other, with source links retried when needed. The original thread and its provider session stay where they were; previous permission approvals do not transfer.

## Revoke access

On the host, authorized administrators can revoke pairing links and client sessions in **Settings → Connections**. Revoking a link prevents new pairings. Revoking a session removes a client's existing access.

Treat pairing URLs and authorization codes as passwords. Keep them out of screenshots, logs, and bug reports.
