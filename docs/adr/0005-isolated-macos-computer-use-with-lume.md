# Isolated macOS computer use uses a leased Lume VM

Status: Accepted.

Linux computer use already runs in a per-thread private rootless-Podman desktop.
macOS instead drives host windows under the background-only policy. That protects
host input but cannot resolve focus races or reach some off-Space SwiftUI windows.
Relaxing the host policy would let agents interrupt the user's desktop.

## Decision

Add an opt-in **isolated macOS desktop** mode on Apple Silicon using
[Lume](https://github.com/trycua/cua/tree/main/libs/lume), an MIT-licensed CLI built
on Apple's Virtualization.framework. Host background-only remains the default;
Intel Macs do not support the isolated mode. Lume installation is user-initiated
from Settings → Integrations → Computer use, never triggered by an agent call.

Cua Driver runs inside the logged-in guest. Paperplane carries its existing stdio MCP
transport over SSH, following Cua's [VM and remote guide](https://cua.ai/docs/cua-driver/guides/vms-and-remote):

```sh
ssh -T lume@<ip> /Users/lume/.local/bin/cua-driver mcp
```

Paperplane generates a dedicated SSH key under its environment state directory and keeps
the private key on the host. Settings returns the exact public-key authorization
command for the user to run inside the guest display. Lume's documented `ssh` and
`cp` commands automate password SSH, not a separate guest-exec channel; Paperplane does
not use the image's default password non-interactively. Each environment uses an
explicit, private Lume storage directory to avoid colliding with other servers.
The guest uses the existing `isolated-desktop` policy: foreground and pixel input
are permitted there, never
on the host. Policy guidance must describe the actual guest rather than assume
Linux tools, four slots, or an offline transport. No project, host home,
credentials, or host clipboard is shared by default, matching Linux isolation.

Use one prepared golden VM per environment and, by default, one working VM with
an exclusive per-thread lease, not a VM for every thread. Reset the working VM
from the stopped golden image with `lume clone` between leases so guest files do
not leak to the next thread. Capacity is fixed at one working VM for now. Any
future increase must respect Apple's limit of two concurrent macOS guests per host, including those outside
Paperplane. Refuse acquisition when capacity is occupied; never evict
unfinished work or fall back to host input. Idle SSH retirement preserves the
lease and documents. Explicit `close_desktop` releases and discards the working
VM, like Linux; disabling computer use, switching to host mode or stopping Paperplane
releases owned leases.

## Consequences

First-run consent requires the user in the VM display, not SSH: Accessibility,
Screen Recording, automation of System Events, and direct screen capture must
all be approved. The setup commands exercise app listing and direct capture;
the user reruns both until they finish without prompts. Verification checks
`permissions status --json` over key-only SSH for Accessibility, Screen Recording
and `source.attribution: "driver-daemon"` before stopping and sealing the image.
Those status flags do not independently attest System Events or direct-capture
consent. Preparation uses the VNC display: Lume's native viewer automatically
shares the host clipboard. Working VMs run detached with no display or VNC
listener. `lume clone` preserves these TCC grants only while `CuaDriver.app` retains its release signing
identity; an ad-hoc build requires fresh consent. Keep the golden image free of
personal files, tokens, and private keys. Clone support is not permission bypass.

macOS guests cost substantially more disk and RAM than Linux containers. Published
images use roughly 150 GB sparse disks; allocated disk usage can grow and each
running guest reserves RAM. Settings must show approximate required disk space
and free space before provisioning. Once the image exists, it also reports actual allocated storage
versus virtual disk size, configured guest RAM, and lease owner/capacity, with
explicit release and image removal. The Lume image cache is not removed by VM
removal; `lume prune` is a separate user decision. Guest unavailability is a
visible failure, not host escalation.

## Rejected alternatives

- **Cua Spaces:** source-available FSL-1.1-MIT, not open source, and requires an
  account/relay instead of local environment ownership.
- **Tart:** Fair Source licensing does not fit Paperplane's open-core requirement.
- **UTM:** Apache-2.0, but GUI-oriented with a poorer automation fit than Lume.
- **Per-thread VMs:** the two-guest host limit and roughly 150 GB sparse images
  make Linux's one-desktop-per-thread model unsuitable for macOS.
- **Host background-only alone:** keep it as the default, but it cannot solve
  focus races or inaccessible off-Space SwiftUI windows without host escalation.
