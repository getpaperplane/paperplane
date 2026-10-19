import {
  computerDesktopViewerUrl,
  threadComputerDesktops,
} from "@rove-code/client-runtime/state/computer-use";
import { type ComputerDesktop, ThreadId } from "@rove-code/contracts";
import { describe, expect, it } from "vite-plus/test";

import { computerPickerNote, newComputerDesktops, typingKeys } from "./computerDesktops.logic";

const desktop = (overrides: Partial<ComputerDesktop>): ComputerDesktop => ({
  id: "d",
  kind: "linux",
  role: "thread",
  threadId: ThreadId.make("thread-a"),
  name: "Linux desktop",
  startedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("computer desktops in the Device panel", () => {
  it("lists a thread's own desktops before the shared setup desktop", () => {
    const state = {
      mode: "isolated" as const,
      revision: 1,
      desktops: [
        desktop({ id: "setup", kind: "macos-vm", role: "setup", threadId: null }),
        desktop({ id: "other", threadId: ThreadId.make("thread-b") }),
        desktop({ id: "mine" }),
      ],
    };
    expect(threadComputerDesktops(state, "thread-a").map((entry) => entry.id)).toEqual([
      "mine",
      "setup",
    ]);
  });

  it("explains a host-mode environment but stays quiet when computer use is off", () => {
    expect(computerPickerNote({ mode: "host", enabled: true, desktopCount: 0 })).toBe("host");
    expect(computerPickerNote({ mode: "isolated", enabled: true, desktopCount: 0 })).toBe("empty");
    expect(computerPickerNote({ mode: "isolated", enabled: true, desktopCount: 1 })).toBeNull();
    expect(computerPickerNote({ mode: "host", enabled: false, desktopCount: 0 })).toBeNull();
    expect(computerPickerNote({ mode: "unavailable", enabled: true, desktopCount: 0 })).toBeNull();
  });

  it("auto-shows only desktops that appear after the first snapshot", () => {
    const existing = desktop({ id: "existing" });
    expect(newComputerDesktops(undefined, [existing])).toEqual([]);
    const fresh = desktop({ id: "fresh" });
    expect(newComputerDesktops(new Set(["existing"]), [existing, fresh])).toEqual([fresh]);
  });
});

describe("computer desktop viewer URL", () => {
  it("keeps the environment origin and forwards only the ticket", () => {
    const access = {
      httpBase: "https://box.tailnet.ts.net:3773/api/device-hub",
      wsBase: "wss://box.tailnet.ts.net:3773/api/device-hub",
      query: { wsTicket: "t 1", hostId: "local" },
      credentials: false,
    };
    expect(computerDesktopViewerUrl(access, "/api/computer-use/desktops/abc/vnc")).toBe(
      "wss://box.tailnet.ts.net:3773/api/computer-use/desktops/abc/vnc?wsTicket=t+1",
    );
    expect(
      computerDesktopViewerUrl(
        { ...access, query: { hostId: "local" }, credentials: true },
        "/api/computer-use/desktops/abc/vnc",
      ),
    ).toBe("wss://box.tailnet.ts.net:3773/api/computer-use/desktops/abc/vnc");
  });
});

describe("typing into a desktop", () => {
  it("maps ASCII to keysyms with Shift where a US keyboard needs it", () => {
    expect(typingKeys("aZ 1|")).toEqual([
      { keysym: 0x61, shift: false },
      { keysym: 0x5a, shift: true },
      { keysym: 0x20, shift: false },
      { keysym: 0x31, shift: false },
      { keysym: 0x7c, shift: true },
    ]);
  });

  it("refuses text it can't type faithfully, including Return", () => {
    expect(typingKeys("echo hi\n")).toBeNull();
    expect(typingKeys("café")).toBeNull();
    expect(typingKeys("")).toEqual([]);
  });
});
