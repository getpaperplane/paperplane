import type { ComputerUseControlInput, ComputerUseStatus } from "@rove-code/contracts";

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
