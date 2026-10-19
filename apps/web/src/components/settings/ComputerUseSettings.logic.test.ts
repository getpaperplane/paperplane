import {
  type ComputerDesktop,
  type ComputerUseMacosVm,
  type ComputerUseStatus,
  ThreadId,
} from "@rove-code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  controlFailureTitle,
  describeDriver,
  describeVm,
  describeVmProgress,
  isDiskBlocked,
  formatDuration,
  isMacStatus,
  primaryAction,
  setupDesktopOf,
  singleLineShellCommand,
  vmActions,
  vmConfirmation,
  vmOf,
  vmSetupStep,
} from "./ComputerUseSettings.logic";

const linux = {
  status: "stopped",
  version: "1.2.3",
  telemetry: false,
  readiness: {
    platform: "linux",
    desktops: 0,
    capacity: 4,
    diagnostics: [
      { label: "display server", status: "ok", message: "X11 desktop" },
      { label: "AT-SPI", status: "ok", message: "Accessibility bus reachable" },
    ],
  },
} satisfies ComputerUseStatus;

const mac = {
  status: "running",
  version: "1.2.3",
  telemetry: false,
  readiness: {
    platform: "darwin",
    permissions: { accessibility: true, screenRecording: false },
  },
} satisfies ComputerUseStatus;

describe("computer use setup", () => {
  it("distinguishes missing prerequisites from an image that needs preparation", () => {
    const unavailable = {
      status: "runtime-unavailable",
      detail: "Install rootless Podman.",
    } satisfies ComputerUseStatus;
    expect(describeDriver(unavailable, null)).toBe("Install rootless Podman.");
    expect(primaryAction(unavailable)).toEqual({ input: { action: "start" }, label: "Retry" });
    const missingImage = { status: "needs-desktop-image" } satisfies ComputerUseStatus;
    expect(primaryAction(missingImage)).toEqual({
      input: { action: "install" },
      label: "Prepare desktop",
    });
    expect(describeDriver(missingImage, null)).toContain("No host folders");
  });
  it("offers installation on Linux instead of describing an unsupported host", () => {
    const missing = { status: "not-installed", platform: "linux" } satisfies ComputerUseStatus;
    expect(describeDriver(missing, null)).toContain("Linux host");
    expect(primaryAction(missing)?.input).toEqual({ action: "install" });
  });

  it("checks a stopped Linux desktop without offering macOS grants", () => {
    expect(primaryAction(linux)).toEqual({ input: { action: "start" }, label: "Check desktop" });
    expect(primaryAction({ ...linux, status: "running" })).toBeNull();
    expect(describeDriver(linux, null)).toContain("desktop image is ready");
    expect(describeDriver({ ...linux, status: "running" }, null)).toContain(
      "0 of 4 private thread desktops",
    );
  });

  it("shows Linux diagnostic remedies even while the runtime is connected", () => {
    const degraded = {
      ...linux,
      status: "running",
      readiness: {
        platform: "linux",
        desktops: 1,
        capacity: 4,
        diagnostics: [
          {
            label: "AT-SPI",
            status: "warn",
            message: "Accessibility bus not reachable",
            detail: "Install at-spi2-core.",
          },
        ],
      },
    } satisfies ComputerUseStatus;
    const text = describeDriver(degraded, null);
    expect(text).toContain("Accessibility bus not reachable");
    expect(text).toContain("Install at-spi2-core");
    expect(text).not.toContain("no diagnostic warnings");
    expect(primaryAction(degraded)).toBeNull();
  });

  it("does not claim readiness when Linux diagnostics could not be read", () => {
    const unknown = {
      ...linux,
      status: "running",
      readiness: { platform: "linux", diagnostics: null, desktops: 0, capacity: 4 },
    } satisfies ComputerUseStatus;
    expect(describeDriver(unknown, null)).toContain("diagnostics could not be read");
    expect(describeDriver(unknown, null)).not.toContain("no diagnostic warnings");
  });

  it("preserves macOS grants and names the missing permission", () => {
    expect(describeDriver(mac, null)).toContain("needs Screen Recording");
    expect(primaryAction(mac)?.input).toEqual({ action: "grant-permissions" });
    const granted = {
      ...mac,
      readiness: {
        platform: "darwin",
        permissions: { accessibility: true, screenRecording: true },
      },
    } satisfies ComputerUseStatus;
    expect(primaryAction(granted)).toBeNull();
    expect(describeDriver(granted, null)).toContain(
      "running with Accessibility and Screen Recording",
    );
  });

  it("preserves unavailable-host and connection-error messages", () => {
    expect(describeDriver({ status: "unsupported", platform: "freebsd" }, null)).toBe(
      "Computer use needs a macOS, Windows, or Linux host. This environment runs freebsd.",
    );
    expect(primaryAction({ status: "unsupported", platform: "freebsd" })).toBeNull();
    expect(describeDriver(null, "Disconnected")).toBe("Disconnected");
  });

  it("retries a runtime that is unavailable by starting the driver again", () => {
    const unavailable = {
      status: "runtime-unavailable",
      detail: "The interactive desktop daemon is not running.",
    } satisfies ComputerUseStatus;
    expect(describeDriver(unavailable, null)).toBe(
      "The interactive desktop daemon is not running.",
    );
    expect(primaryAction(unavailable)).toEqual({
      input: { action: "start" },
      label: "Retry",
    });
  });

  it("names a Windows PC when Cua Driver is not installed there", () => {
    const missing = { status: "not-installed", platform: "win32" } satisfies ComputerUseStatus;
    expect(describeDriver(missing, null)).toContain("Windows PC");
    expect(primaryAction(missing)?.input).toEqual({ action: "install" });
  });

  it("describes a stopped and running Windows driver without macOS permissions", () => {
    const stopped = {
      status: "stopped",
      version: "1.2.3",
      telemetry: null,
      readiness: { platform: "win32", permissions: null },
    } satisfies ComputerUseStatus;
    expect(describeDriver(stopped, null)).toBe(
      "Cua Driver 1.2.3 is installed. Start it to let agents use apps on this Windows desktop.",
    );
    expect(primaryAction(stopped)).toEqual({ input: { action: "start" }, label: "Start" });

    const running = { ...stopped, status: "running" } satisfies ComputerUseStatus;
    expect(describeDriver(running, null)).toBe(
      "Cua Driver 1.2.3 is running in your Windows desktop session. Apps running as administrator can't be controlled.",
    );
    expect(describeDriver(running, null)).not.toContain("ermission");
    expect(primaryAction(running)).toBeNull();
  });

  it("uses platform-neutral wording for an unverified driver", () => {
    const untrusted = { status: "untrusted" } satisfies ComputerUseStatus;
    expect(describeDriver(untrusted, null)).toContain("isn't verified as Cua AI, Inc.'s release");
    expect(describeDriver(untrusted, null)).not.toContain("Mac");
    expect(primaryAction(untrusted)).toEqual({ input: { action: "install" }, label: "Reinstall" });
  });
});

const vmBase = {
  leased: 0,
  capacity: 1,
  owners: [],
  installCommand: "brew install lume",
  requiredDiskBytes: 150e9,
} satisfies Partial<ComputerUseMacosVm>;

describe("isolated macOS VM setup", () => {
  it("describes and offers the next step for a missing Lume install", () => {
    const vm = { ...vmBase, state: "missing-lume" } satisfies ComputerUseMacosVm;
    expect(describeVm(vm)).toBe(
      "Install Lume, Cua's open-source VM tool, to create the private macOS VM.",
    );
    expect(vmActions(vm)).toEqual([{ input: { action: "install" }, label: "Install Lume" }]);
  });

  it("explains the disk cost before preparing the image", () => {
    const vm = {
      ...vmBase,
      state: "needs-image",
      freeDiskBytes: 210.4e9,
    } satisfies ComputerUseMacosVm;
    expect(describeVm(vm)).toBe(
      "Downloads Cua's macOS image (about 150 GB on disk, 210.4 GB free) and sets it up in the background.",
    );
    const { freeDiskBytes: _free, ...unknownFree } = vm;
    expect(describeVm(unknownFree)).toBe(
      "Downloads Cua's macOS image (about 150 GB on disk) and sets it up in the background.",
    );
    expect(vmActions(vm)).toEqual([{ input: { action: "prepare-vm" }, label: "Prepare VM" }]);
  });

  it("blocks Prepare when free disk is below the requirement", () => {
    const base = { ...vmBase, state: "needs-image" } satisfies ComputerUseMacosVm;
    const short = { ...base, freeDiskBytes: 80.25e9 } satisfies ComputerUseMacosVm;
    expect(describeVm(short)).toBe(
      "Needs about 150 GB of free disk, but only 80.3 GB is free. Free up space, then check again.",
    );
    expect(vmActions(short)).toEqual([
      { input: { action: "prepare-vm" }, label: "Prepare VM", disabled: true },
    ]);
    expect(isDiskBlocked(short)).toBe(true);

    for (const free of [150e9, 400e9]) {
      const enough = { ...base, freeDiskBytes: free } satisfies ComputerUseMacosVm;
      expect(vmActions(enough)).toEqual([{ input: { action: "prepare-vm" }, label: "Prepare VM" }]);
      expect(isDiskBlocked(enough)).toBe(false);
    }
    // Unknown free space never blocks; the server decides.
    expect(vmActions(base)).toEqual([{ input: { action: "prepare-vm" }, label: "Prepare VM" }]);
    expect(isDiskBlocked(base)).toBe(false);
  });

  it("walks through consent with the setup command", () => {
    const vm = {
      ...vmBase,
      state: "needs-consent",
      setupCommand: "cua-setup",
    } satisfies ComputerUseMacosVm;
    expect(describeVm(vm)).toBe(
      "Open the setup desktop, approve the permission prompts inside the VM, then select Verify.",
    );
    expect(vmSetupStep(vm)).toBe("permissions");
    expect(vmActions(vm).map((action) => action.input.action)).toEqual([
      "open-vm-display",
      "verify-vm",
      "remove-vm",
    ]);
  });

  it("reports usage and offers release only while the VM is leased", () => {
    const idle = {
      ...vmBase,
      state: "ready",
      diskBytes: 42.5e9,
      virtualDiskBytes: 150e9,
      memoryBytes: 8e9,
    } satisfies ComputerUseMacosVm;
    expect(describeVm(idle)).toBe("Ready. 0 of 1 VM in use. Disk 42.5 GB of 150.0 GB, RAM 8.0 GB.");
    expect(vmActions(idle)).toEqual([{ input: { action: "remove-vm" }, label: "Remove VM" }]);

    const leased = {
      ...idle,
      leased: 1,
      owners: ["thread-a", "thread-b"],
    } satisfies ComputerUseMacosVm;
    expect(describeVm(leased)).toContain("1 of 1 VM in use by thread-a, thread-b.");
    expect(vmActions(leased).map((action) => action.label)).toEqual(["Release VM", "Remove VM"]);
    const { diskBytes: _disk, ...noDisk } = idle;
    expect(describeVm(noDisk)).toBe("Ready. 0 of 1 VM in use.");
  });

  it("says why isolated desktops are unavailable and offers no action", () => {
    expect(describeVm({ ...vmBase, state: "unavailable" })).toBe(
      "Isolated macOS desktops need an Apple Silicon Mac.",
    );
    expect(describeVm({ ...vmBase, state: "unavailable", detail: "Intel Mac." })).toBe(
      "Intel Mac.",
    );
    expect(vmActions({ ...vmBase, state: "unavailable" })).toEqual([]);
    expect(
      vmActions({ ...vmBase, state: "unavailable", lumeVersion: "0.3.0" }).map(
        (action) => action.input.action,
      ),
    ).toEqual(["remove-vm"]);
  });

  it("opens the setup desktop during driver installation only", () => {
    for (const phase of ["downloading", "unpacking", "booting", "installing-driver"] as const) {
      const vm = {
        ...vmBase,
        state: "preparing",
        progress: { phase, startedAt: 0 },
      } satisfies ComputerUseMacosVm;
      expect(vmActions(vm).map((action) => action.input.action)).toEqual(
        phase === "installing-driver"
          ? ["open-vm-display", "cancel-prepare-vm"]
          : ["cancel-prepare-vm"],
      );
    }
  });

  it("offers only Cancel before driver installation and retry after a failed preparation", () => {
    const preparing = {
      ...vmBase,
      state: "preparing",
      progress: { phase: "downloading", percent: 42, startedAt: 0 },
    } satisfies ComputerUseMacosVm;
    expect(vmActions(preparing)).toEqual([
      { input: { action: "cancel-prepare-vm" }, label: "Cancel" },
    ]);
    expect(vmConfirmation({ action: "cancel-prepare-vm" })).toContain("progress is lost");
    expect(controlFailureTitle("cancel-prepare-vm")).toBe("Couldn't cancel preparing the VM");
    const failed = {
      ...vmBase,
      state: "needs-image",
      lastError: "Disk full",
    } satisfies ComputerUseMacosVm;
    expect(vmActions(failed)).toEqual([{ input: { action: "prepare-vm" }, label: "Try again" }]);
  });

  it("places each state on the setup checklist", () => {
    const at = (vm: ComputerUseMacosVm) => vmSetupStep(vm);
    expect(at({ ...vmBase, state: "needs-image" })).toBe("download");
    expect(at({ ...vmBase, state: "preparing" })).toBe("download");
    expect(
      at({ ...vmBase, state: "preparing", progress: { phase: "unpacking", startedAt: 0 } }),
    ).toBe("download");
    expect(
      at({ ...vmBase, state: "preparing", progress: { phase: "booting", startedAt: 0 } }),
    ).toBe("driver");
    expect(
      at({ ...vmBase, state: "preparing", progress: { phase: "installing-driver", startedAt: 0 } }),
    ).toBe("driver");
    expect(at({ ...vmBase, state: "ready" })).toBeNull();
    expect(at({ ...vmBase, state: "missing-lume" })).toBeNull();
  });

  it("formats download progress with an ETA and other phases with elapsed time", () => {
    expect(
      describeVmProgress(
        { phase: "downloading", percent: 42.7, etaSeconds: 3720, startedAt: 0 },
        0,
      ),
    ).toEqual({ text: "Downloading macOS image · 42% · about 1 h 2 min left", percent: 42 });
    expect(describeVmProgress({ phase: "downloading", startedAt: 0 }, 10_000)).toEqual({
      text: "Downloading macOS image · just started",
      percent: null,
    });
    expect(
      describeVmProgress({ phase: "unpacking", percent: 80, startedAt: 0 }, 50 * 60_000),
    ).toEqual({ text: "Unpacking image · started 50 min ago", percent: null });
    expect(
      describeVmProgress({ phase: "downloading", percent: 99, etaSeconds: 20, startedAt: 0 }, 0)
        .text,
    ).toBe("Downloading macOS image · 99% · less than a minute left");
    expect(describeVmProgress(undefined, 0)).toEqual({ text: "Starting…", percent: null });
    expect(
      describeVmProgress({ phase: "downloading", percent: 140, startedAt: 0 }, 0).percent,
    ).toBe(100);
  });

  it("rounds durations to readable units", () => {
    expect(formatDuration(30)).toBe("less than a minute");
    expect(formatDuration(12 * 60)).toBe("12 min");
    expect(formatDuration(2 * 3600)).toBe("2 h");
    expect(formatDuration(3600 + 125)).toBe("1 h 2 min");
  });

  it("titles each failed action", () => {
    expect(controlFailureTitle("open-vm-display")).toBe("Couldn't open the setup desktop");
    expect(controlFailureTitle("remove-vm")).toBe("Couldn't remove the VM");
  });

  it("confirms only the destructive VM actions", () => {
    expect(vmConfirmation({ action: "release-vm" })).toBe(
      "This discards the VM's open apps and unsaved files.",
    );
    expect(vmConfirmation({ action: "remove-vm" })).toBe(
      "This deletes the macOS VM image. You'll need to prepare it again.",
    );
    expect(vmConfirmation({ action: "prepare-vm" })).toBeNull();
  });

  it("finds the VM state only in isolated-vm readiness on darwin", () => {
    const vm = { ...vmBase, state: "needs-image" } satisfies ComputerUseMacosVm;
    const isolated = {
      status: "stopped",
      version: "1.2.3",
      telemetry: null,
      readiness: { platform: "darwin", mode: "isolated-vm", permissions: null, vm },
    } satisfies ComputerUseStatus;
    expect(vmOf(isolated)).toBe(vm);
    expect(vmOf(mac)).toBeNull();
    expect(isMacStatus(isolated)).toBe(true);
    expect(isMacStatus({ status: "not-installed", platform: "darwin" })).toBe(true);
    expect(isMacStatus({ status: "not-installed", platform: "linux" })).toBe(false);
  });
});

describe("setup desktop", () => {
  const desktop = (overrides: Partial<ComputerDesktop>): ComputerDesktop => ({
    id: "vm:rove-cua-golden",
    kind: "macos-vm",
    role: "setup",
    threadId: null,
    name: "macOS desktop setup",
    startedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

  it("finds only the macOS setup desktop, not thread desktops", () => {
    const thread = desktop({ id: "vm:work", role: "thread", threadId: ThreadId.make("t") });
    const setup = desktop({});
    expect(setupDesktopOf({ mode: "isolated", revision: 1, desktops: [thread] })).toBeNull();
    expect(setupDesktopOf({ mode: "isolated", revision: 2, desktops: [thread, setup] })).toBe(
      setup,
    );
  });

  it("joins the setup script into one line the shell runs the same way", () => {
    const script = [
      "umask 077 && mkdir -p ~/.ssh &&",
      "chmod 600 ~/.ssh/authorized_keys &&",
      "driver permissions grant",
      "driver list_apps '{}'",
      "# Approve all prompts, then rerun.",
      "",
      "driver permissions status --json",
    ].join("\n");
    expect(singleLineShellCommand(script)).toBe(
      "umask 077 && mkdir -p ~/.ssh && chmod 600 ~/.ssh/authorized_keys && driver permissions grant; driver list_apps '{}'; driver permissions status --json",
    );
    expect(singleLineShellCommand("a \\\n  b\r\nc |\nd")).toBe("a b; c | d");
  });
});
