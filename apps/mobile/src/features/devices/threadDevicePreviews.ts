import type {
  ComputerDesktop,
  ComputerDesktopsState,
  DeviceServiceState,
  ThreadId,
} from "@getpaperplane/contracts";
import { threadComputerDesktops } from "@getpaperplane/client-runtime/state/computer-use";

/** Host identity is part of the selection because Android serials repeat across hosts. */
export function threadDevicePreviews(state: DeviceServiceState | null, threadId: ThreadId) {
  return (state?.sessions ?? [])
    .filter((session) => session.threadId === threadId)
    .map((session) => {
      const device = state?.devices.find(
        (device) => device.hostId === session.hostId && device.id === session.deviceId,
      );
      const host = state?.hosts.find((host) => host.id === session.hostId);
      return {
        kind: "device" as const,
        key: JSON.stringify([session.hostId, session.deviceId]),
        session,
        name: device?.name ?? (session.platform === "ios" ? "iOS Simulator" : "Android Emulator"),
        description: [device?.version, host?.label].filter(Boolean).join(" · "),
      };
    });
}

export type ThreadDevicePreview = ReturnType<typeof threadDevicePreviews>[number];

export interface ThreadDesktopPreview {
  readonly kind: "desktop";
  readonly key: string;
  readonly desktop: ComputerDesktop;
  readonly name: string;
  readonly description: string;
}

export type ThreadPreview = ThreadDevicePreview | ThreadDesktopPreview;

/** Computer-use desktops the thread may watch (its own plus the shared setup desktop). */
export function threadDesktopPreviews(
  state: ComputerDesktopsState,
  threadId: ThreadId,
): ThreadDesktopPreview[] {
  return threadComputerDesktops(state, threadId).map((desktop) => ({
    kind: "desktop" as const,
    // Prefixed so a desktop id can never collide with a [hostId, deviceId] key.
    key: JSON.stringify(["desktop", desktop.id]),
    desktop,
    name: desktop.name,
    description: desktop.kind === "linux" ? "Private Linux desktop" : "Isolated macOS VM",
  }));
}

/** Devices first, then desktops, in one list the viewer can pick from. */
export function threadPreviews(
  deviceState: DeviceServiceState | null,
  desktopsState: ComputerDesktopsState,
  threadId: ThreadId,
): ThreadPreview[] {
  return [
    ...threadDevicePreviews(deviceState, threadId),
    ...threadDesktopPreviews(desktopsState, threadId),
  ];
}

export function selectedThreadDevicePreview<T extends { readonly key: string }>(
  previews: ReadonlyArray<T>,
  selectedKey: string | null,
) {
  return previews.find((preview) => preview.key === selectedKey) ?? previews[0] ?? null;
}
