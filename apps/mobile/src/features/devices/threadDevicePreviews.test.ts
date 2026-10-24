import {
  ThreadId,
  type ComputerDesktopsState,
  type DeviceServiceState,
} from "@getpaperplane/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  selectedThreadDevicePreview,
  threadDevicePreviews,
  threadPreviews,
} from "./threadDevicePreviews";

const threadId = ThreadId.make("thread");
const state: DeviceServiceState = {
  hosts: [
    {
      id: "local",
      kind: "local",
      label: "Local",
      platforms: [],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
    {
      id: "remote",
      kind: "ssh",
      label: "Mac mini",
      platforms: [],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "ready",
  hostStatuses: {},
  devices: [
    {
      hostId: "local",
      id: "emulator-5554",
      platform: "android",
      name: "Pixel 9",
      version: "Android 16",
      booted: true,
      physical: false,
    },
    {
      hostId: "remote",
      id: "emulator-5554",
      platform: "android",
      name: "Pixel 8",
      version: "Android 15",
      booted: true,
      physical: false,
    },
  ],
  sessions: [
    {
      threadId,
      hostId: "local",
      deviceId: "emulator-5554",
      platform: "android",
      openedAt: "2026-09-18T00:00:00Z",
    },
    {
      threadId,
      hostId: "remote",
      deviceId: "emulator-5554",
      platform: "android",
      openedAt: "2026-09-18T00:01:00Z",
    },
    {
      threadId: ThreadId.make("another-thread"),
      hostId: "local",
      deviceId: "iphone",
      platform: "ios",
      openedAt: "2026-09-18T00:02:00Z",
    },
  ],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device-hub",
  revision: 1,
};

describe("thread device previews", () => {
  it("keeps device names and selection distinct when hosts have the same Android serial", () => {
    const previews = threadDevicePreviews(state, threadId);
    expect(previews.map((preview) => preview.name)).toEqual(["Pixel 9", "Pixel 8"]);
    expect(new Set(previews.map((preview) => preview.key)).size).toBe(2);
    expect(selectedThreadDevicePreview(previews, previews[1]!.key)?.description).toBe(
      "Android 15 · Mac mini",
    );
  });

  it("selects another open device when the agent closes the selected session", () => {
    const previews = threadDevicePreviews(state, threadId);
    const selectedKey = previews[1]!.key;
    const afterClose = threadDevicePreviews({ ...state, sessions: [state.sessions[0]!] }, threadId);
    expect(selectedThreadDevicePreview(afterClose, selectedKey)?.name).toBe("Pixel 9");
    expect(selectedThreadDevicePreview([], selectedKey)).toBeNull();
  });

  it("can view an open session before device discovery metadata arrives", () => {
    const previews = threadDevicePreviews({ ...state, hosts: [], devices: [] }, threadId);
    expect(previews[0]?.name).toBe("Android Emulator");
    expect(previews[0]?.session.deviceId).toBe("emulator-5554");
    expect(previews[0]?.description).toBe("");
  });

  it("offers no devices before state arrives or in a thread without sessions", () => {
    expect(threadDevicePreviews(null, threadId)).toEqual([]);
    expect(threadDevicePreviews(state, ThreadId.make("empty-thread"))).toEqual([]);
  });
});

describe("thread previews with computer desktops", () => {
  const desktops: ComputerDesktopsState = {
    mode: "isolated",
    revision: 1,
    desktops: [
      {
        id: "setup",
        kind: "macos-vm",
        role: "setup",
        threadId: null,
        name: "Setup VM",
        startedAt: "2026-09-18T00:00:00Z",
      },
      {
        id: "mine",
        kind: "linux",
        role: "thread",
        threadId,
        name: "Desktop",
        startedAt: "2026-09-18T00:00:01Z",
      },
      {
        id: "other",
        kind: "linux",
        role: "thread",
        threadId: ThreadId.make("another-thread"),
        name: "Other",
        startedAt: "2026-09-18T00:00:02Z",
      },
    ],
  };

  it("lists devices first, then the thread's desktops, and hides other threads' desktops", () => {
    const previews = threadPreviews(state, desktops, threadId);
    expect(previews.map((preview) => preview.kind)).toEqual([
      "device",
      "device",
      "desktop",
      "desktop",
    ]);
    expect(previews.slice(2).map((preview) => preview.name)).toEqual(["Desktop", "Setup VM"]);
    expect(previews[3]?.description).toBe("Isolated macOS VM");
  });

  it("offers a desktop alone, with distinct selectable keys", () => {
    const previews = threadPreviews(null, desktops, threadId);
    expect(previews).toHaveLength(2);
    expect(new Set(previews.map((preview) => preview.key)).size).toBe(2);
    expect(selectedThreadDevicePreview(previews, previews[1]!.key)?.name).toBe("Setup VM");
    expect(threadPreviews(null, { ...desktops, desktops: [] }, threadId)).toEqual([]);
  });
});
