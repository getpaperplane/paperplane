import type { ComputerUseMacosVm, ComputerUseStatus } from "@rove-code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeDriver,
  describeVm,
  isMacStatus,
  primaryAction,
  vmActions,
  vmConfirmation,
  vmOf,
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
      "Download Cua's macOS image (about 150 GB on disk, 210.4 GB free) and open it so you can approve permissions.",
    );
    const { freeDiskBytes: _free, ...unknownFree } = vm;
    expect(describeVm(unknownFree)).toBe(
      "Download Cua's macOS image (about 150 GB on disk) and open it so you can approve permissions.",
    );
    expect(vmActions(vm)).toEqual([{ input: { action: "prepare-vm" }, label: "Prepare VM" }]);
  });

  it("walks through consent with the setup command", () => {
    const vm = {
      ...vmBase,
      state: "needs-consent",
      setupCommand: "cua-setup",
    } satisfies ComputerUseMacosVm;
    expect(describeVm(vm)).toBe(
      "Rove installs the driver automatically. Open the VM, approve the permission prompts, then select Verify. If setup did not complete or prompts are missing, use Manual setup in the VM's Terminal.",
    );
    expect(vmActions(vm).map((action) => action.input.action)).toEqual([
      "open-vm-display",
      "verify-vm",
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
