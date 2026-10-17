# Computer use

Agents use [Cua Driver](https://cua.ai/docs/cua-driver) to discover apps, inspect
accessibility state, click, type, and capture screenshots. Every provider connected
through Rove Code gets the same tools. Computer use is off by default.

On macOS, agents act on your apps in the background. Desktop input, foreground
escalation, shared clipboard writes, and driver configuration changes are refused.
If a GUI step cannot run in the background, the agent can use an app API or report
that step as blocked. Agents act through accessibility elements, which never change
which app has focus. Clicking by screen position is off by default because it can
briefly change focus while you work; turn on **Allow pixel input** in the same
settings section if you need it. SwiftUI windows on another Space cannot
be controlled in the background, though agents can still see them. Move the window to
the current Space. These restrictions apply to Computer Use tools, not shell
commands or actions an app takes in response.

On Linux, including WSL, each thread gets a private, headless desktop. Its focus,
pointer, clipboard, and apps are separate from your desktop and other threads.
There is no host-desktop fallback. No display, WSLg, or physical monitor is needed.
Apple Silicon Macs can opt into a private VM instead of host apps. Windows does not
have a private desktop.

For web pages, agents keep using Rove Code's browser panel.

## Set it up

Open **Settings → Integrations → Computer use**. Select **Install** if Cua Driver
is missing, then turn on **Agent computer use**. Rove uses Cua's official installer,
which downloads the driver from Cua's GitHub releases.

### macOS

Select **Check permissions** to start Cua Driver. If permissions are missing, select
**Grant permissions**. Allow Accessibility and Screen Recording for Cua Driver.
macOS asks on the Mac running the environment, not the device you use to connect.

The installer puts `CuaDriver.app` in `/Applications`. Rove checks that Cua AI, Inc.
signed the app and refuses to run it otherwise. macOS grants these permissions to
Cua Driver, not Rove. Revoke them in **System Settings → Privacy & Security**.

### Isolated macOS desktop (Apple Silicon)

Host background-only mode remains the default. On an Apple Silicon Mac, select
**Isolated macOS desktop** in Computer use settings. Install Lume when prompted,
then **Prepare VM**. The first download is large: the Tahoe image has a roughly
150 GB sparse disk. Review free space, allocated storage, virtual disk size and
configured memory before using it. Lume and Cua Driver are MIT-licensed.

Preparation opens the golden VM in a display. Run the setup commands shown in
Settings **in Terminal inside that VM**, not on your host. They authorize Rove's
public SSH key, install Cua Driver and request consent. Allow Accessibility,
Screen Recording, control of System Events and direct screen capture. Rerun the
app-list and screen-capture commands until they complete without prompts, then
select **Verify VM**. Rove checks the app-owned daemon's grants over key-only SSH
and stops the golden image. Never put personal files, tokens or private keys in
this image; each working desktop starts as a copy of it.

One thread can lease the desktop at a time. Pixel and foreground input are allowed
inside the VM only. No project folder, host home, credentials or host clipboard
is shared. The VM has NAT networking; unlike the Linux desktop, it is not offline.
There is no host fallback when the VM is unavailable or occupied. Apple permits
only two running macOS guests in total, including VMs outside Rove.

Ask the agent to call `close_desktop`, or select **Release desktop** in Settings,
to discard the working copy and its documents. Idle SSH retirement preserves the
lease. Turning computer use off, switching to host mode or stopping Rove discards
it. **Remove VM** also removes the prepared golden image; Lume's download cache
is separate and can be reclaimed with `lume prune` when you no longer need it.
The host-only permission and usage-data controls do not apply in this mode.

### Windows

Install Cua Driver from Settings on the Windows host. Stay signed in to its desktop
session: the driver runs there through a Scheduled Task, not in SSH or Session 0.
Use Settings to start it again if the task is stopped. Elevated (administrator)
apps cannot be controlled. Windows uses the same background-only policy and
**Allow pixel input** setting as macOS; no Accessibility or Screen Recording grants
are needed. Rove verifies Cua's Authenticode signatures before running the driver.
Older unsigned releases are checked against Cua's published release checksums;
the first verification of those releases needs internet access.

### Linux and WSL

Install rootless Podman on the machine running the environment. On Debian or Ubuntu,
run `sudo apt install podman uidmap` yourself. Run Rove as an unprivileged user, and
check that `podman info` works for that user. Rove does not ask for a sudo password
or use a remote Podman connection.

Select **Install** or **Prepare desktop** to build the private desktop image. The
first build needs internet access and downloads Ubuntu desktop packages. Rove
includes the installed Cua executable in an image identified by its contents.
Updating that executable may require preparing another image. The driver is
installed in `~/.local/bin` by default. An existing driver on `PATH` is also detected.

Select **Check desktop** to test the private graphical session. Runtime problems
are reported here. They never cause Rove to attach to your host display.

## Using a Linux desktop

The initial desktop includes Mousepad and basic desktop tools. For example, ask the
agent to open Mousepad, create a new unsaved document, and verify the text it typed.
Accessibility input is preferred. Foreground and pixel input are allowed inside
this private desktop because they cannot change your host focus or pointer.

The guest is offline. It has no project mount, host home, credentials, browser
profile, or host clipboard. Paths and files used by computer-use tools belong to
the guest. This desktop cannot open your host apps or edit your project files.
Use shell tools for project work and the browser panel for web tasks.

Rove allows four thread desktops at once. A fifth thread is refused until a slot
is explicitly released. Rove does not silently evict unfinished documents.

## Lifetime and stopping

An idle Cua connection closes after five minutes. On Linux and in isolated macOS mode, the private desktop
stays alive, including unsaved documents. The next call reconnects to it, but
snapshot and capture references must be refreshed. Ask the agent to use
`close_desktop` when finished. This discards only that thread's desktop, including
all unsaved documents and guest files. The next call creates a new empty desktop.

Turning off **Agent computer use** refuses new agent calls. It also discards all
Linux desktops and working macOS VMs. Stopping the Rove server discards them too. They are temporary
workspaces, not durable storage. After an abrupt failure, Rove removes desktops
whose recorded server process has died. Desktops belonging to another live Rove
server are left alone. Do not expect documents to survive a restart.

In macOS host mode, Rove quits the shared daemon after its connections retire only if Rove
started it. A separately started daemon is left running. On Windows, Rove closes
its connections but never stops the Scheduled Task's daemon.

## Usage data

Cua's usage collection is disabled inside Linux agent desktops; the macOS VM setup
commands disable it in the golden image too. In host mode on macOS and Windows, Cua can
send a pseudonymous installation ID and content-free usage counts. Rove turns this
off when it installs Cua. An existing installation keeps its preference. Change
that preference with **Share usage data with Cua**.
