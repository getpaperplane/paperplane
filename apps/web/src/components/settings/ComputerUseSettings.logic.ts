import type {
  ComputerUseControlInput,
  ComputerUseMacosVm,
  ComputerUseStatus,
} from "@rove-code/contracts";

function hostName(platform: "darwin" | "linux" | "win32"): string {
  switch (platform) {
    case "linux":
      return "Linux host";
    case "win32":
      return "Windows PC";
    case "darwin":
      return "Mac";
  }
}

export function describeDriver(status: ComputerUseStatus | null, error: string | null): string {
  if (status === null) return error ?? "Checking Cua Driver on this environment…";
  switch (status.status) {
    case "unsupported":
      return `Computer use needs a macOS, Windows, or Linux host. This environment runs ${status.platform}.`;
    case "not-installed":
      return `Not installed on this environment's ${hostName(status.platform)}. Install downloads it from Cua's official releases.`;
    case "runtime-unavailable":
      return status.detail;
    case "needs-desktop-image":
      return "Prepare the private Linux desktop image. This downloads desktop packages and includes Cua Driver. No host folders, credentials, clipboard or display are shared.";
    case "untrusted":
      return "The installed Cua Driver isn't verified as Cua AI, Inc.'s release, so Rove won't run it. Reinstall it from Cua's official releases.";
    case "stopped":
    case "running": {
      const readiness = status.readiness;
      if (readiness.platform === "linux") {
        const prefix = `Cua Driver ${status.version}. ${readiness.desktops} of ${readiness.capacity} private thread desktops in use.`;
        const lifecycle =
          " Offline guest apps and files are temporary. close_desktop, turning this off, or stopping Rove discards them. Idle connections close without discarding documents.";
        if (status.status === "stopped") return `${prefix} The desktop image is ready.${lifecycle}`;
        if (readiness.diagnostics === null)
          return `${prefix} A connection is active, but guest diagnostics could not be read.${lifecycle}`;
        const issues = readiness.diagnostics.filter((probe) => probe.status !== "ok");
        return issues.length === 0
          ? `${prefix} Guest checks passed.${lifecycle}`
          : `${prefix} ${issues.map((probe) => `${probe.label}. ${probe.message}.${probe.detail ? ` ${probe.detail}` : ""}`).join(" ")}${lifecycle}`;
      }
      if (readiness.platform === "win32") {
        return status.status === "stopped"
          ? `Cua Driver ${status.version} is installed. Start it to let agents use apps on this Windows desktop.`
          : `Cua Driver ${status.version} is running in your Windows desktop session. Apps running as administrator can't be controlled.`;
      }
      if (status.status === "stopped") {
        return `Cua Driver ${status.version} starts when an agent needs it and quits after 5 idle minutes.`;
      }
      if (readiness.permissions === null) {
        return `Cua Driver ${status.version} is running, but its permissions could not be read.`;
      }
      const missing = [
        readiness.permissions.accessibility ? null : "Accessibility",
        readiness.permissions.screenRecording ? null : "Screen Recording",
      ].filter((name) => name !== null);
      return missing.length === 0
        ? `Cua Driver ${status.version} is running with Accessibility and Screen Recording.`
        : `Cua Driver needs ${missing.join(" and ")}. macOS asks on the Mac running this environment.`;
    }
  }
}

export function primaryAction(
  status: ComputerUseStatus | null,
): { input: ComputerUseControlInput; label: string } | null {
  switch (status?.status) {
    case "not-installed":
      return { input: { action: "install" }, label: "Install" };
    case "runtime-unavailable":
      return { input: { action: "start" }, label: "Retry" };
    case "needs-desktop-image":
      return { input: { action: "install" }, label: "Prepare desktop" };
    case "untrusted":
      return { input: { action: "install" }, label: "Reinstall" };
    case "stopped": {
      const platform = status.readiness.platform;
      return {
        input: { action: "start" },
        label:
          platform === "linux"
            ? "Check desktop"
            : platform === "win32"
              ? "Start"
              : "Check permissions",
      };
    }
    case "running": {
      const readiness = status.readiness;
      if (readiness.platform === "linux" || readiness.platform === "win32") return null;
      return readiness.permissions?.accessibility && readiness.permissions.screenRecording
        ? null
        : { input: { action: "grant-permissions" }, label: "Grant permissions" };
    }
    default:
      return null;
  }
}

type VmAction = { input: ComputerUseControlInput; label: string };

function gigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** The Mac row (mode picker) applies to any darwin status, including one not yet installed. */
export function isMacStatus(status: ComputerUseStatus | null): boolean {
  if (status === null) return false;
  if (status.status === "not-installed") return status.platform === "darwin";
  return (
    (status.status === "stopped" || status.status === "running") &&
    status.readiness.platform === "darwin"
  );
}

/** The isolated macOS VM state, or null when this status is not in VM mode. */
export function vmOf(status: ComputerUseStatus | null): ComputerUseMacosVm | null {
  if (status?.status !== "stopped" && status?.status !== "running") return null;
  const readiness = status.readiness;
  return readiness.platform === "darwin" && readiness.mode === "isolated-vm" ? readiness.vm : null;
}

export function describeVm(vm: ComputerUseMacosVm): string {
  switch (vm.state) {
    case "unavailable":
      return vm.detail ?? "Isolated macOS desktops need an Apple Silicon Mac.";
    case "missing-lume":
      return "Install Lume, Cua's open-source VM tool, to create the private macOS VM.";
    case "needs-image": {
      const free = vm.freeDiskBytes === undefined ? "" : `, ${gigabytes(vm.freeDiskBytes)} free`;
      return `Download Cua's macOS image (about ${Math.round(vm.requiredDiskBytes / 1e9)} GB on disk${free}) and open it so you can approve permissions.`;
    }
    case "needs-consent":
      return "Open the VM and approve the permission prompts, then select Verify. Rove installed the driver automatically.";
    case "ready": {
      const owners = vm.owners.length === 0 ? "" : ` by ${vm.owners.join(", ")}`;
      const disk =
        vm.diskBytes === undefined || vm.virtualDiskBytes === undefined
          ? ""
          : ` Disk ${gigabytes(vm.diskBytes)} of ${gigabytes(vm.virtualDiskBytes)}${vm.memoryBytes === undefined ? "" : `, RAM ${gigabytes(vm.memoryBytes)}`}.`;
      return `Ready. ${vm.leased} of ${vm.capacity} VM in use${owners}.${disk}`;
    }
  }
}

const REMOVE_VM: VmAction = { input: { action: "remove-vm" }, label: "Remove VM" };

/** Remove is an escape hatch for a reset, so it never leads the action list. */
export function isRemoveAction(input: ComputerUseControlInput): boolean {
  return input.action === "remove-vm";
}

/** Toast title when a control action fails. */
export function controlFailureTitle(action: ComputerUseControlInput["action"]): string {
  switch (action) {
    case "install":
      return "Couldn't install";
    case "start":
      return "Couldn't check Cua Driver";
    case "grant-permissions":
      return "Couldn't grant permissions";
    case "set-telemetry":
      return "Couldn't save the setting";
    case "prepare-vm":
      return "Couldn't prepare the VM";
    case "verify-vm":
      return "Couldn't verify the VM";
    case "open-vm-display":
      return "Couldn't open the VM";
    case "release-vm":
      return "Couldn't release the VM";
    case "remove-vm":
      return "Couldn't remove the VM";
  }
}

export function vmActions(vm: ComputerUseMacosVm): VmAction[] {
  switch (vm.state) {
    case "unavailable":
      return vm.lumeVersion === undefined ? [] : [REMOVE_VM];
    case "missing-lume":
      return [{ input: { action: "install" }, label: "Install Lume" }];
    case "needs-image":
      return [{ input: { action: "prepare-vm" }, label: "Prepare VM" }];
    case "needs-consent":
      return [
        { input: { action: "open-vm-display" }, label: "Open VM" },
        { input: { action: "verify-vm" }, label: "Verify" },
        REMOVE_VM,
      ];
    case "ready":
      return [
        ...(vm.leased > 0
          ? [{ input: { action: "release-vm" as const }, label: "Release VM" }]
          : []),
        REMOVE_VM,
      ];
  }
}

/** Destructive VM actions confirm first; `null` means run without asking. */
export function vmConfirmation(input: ComputerUseControlInput): string | null {
  switch (input.action) {
    case "release-vm":
      return "This discards the VM's open apps and unsaved files.";
    case "remove-vm":
      return "This deletes the macOS VM image. You'll need to prepare it again.";
    default:
      return null;
  }
}
