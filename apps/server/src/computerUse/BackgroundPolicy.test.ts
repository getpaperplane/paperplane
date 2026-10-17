import { expect, it } from "vite-plus/test";

import type { CuaTool } from "./CuaDriver.ts";
import {
  applyBackgroundPolicy,
  backgroundRefusal,
  isAllowedTool,
  instructionsFor,
  offSpaceNote,
} from "./BackgroundPolicy.ts";

const tool = (
  name: string,
  properties: CuaTool["inputSchema"]["properties"] = { delivery_mode: {} },
) => ({
  name,
  description: name,
  inputSchema: { type: "object" as const, properties },
  readOnly: false,
});
it("gives platform-specific background guidance", () => {
  expect(instructionsFor("background-only", "darwin")).toContain("macOS Space");
  const windows = instructionsFor("background-only", "win32");
  expect(windows).not.toContain("macOS Space");
  expect(windows).toContain("administrator");
  expect(windows).toContain("Pixel (x/y) input is off");
  expect(instructionsFor("isolated-desktop", "linux")).toContain("private, offline Linux desktop");
});

it("describes the actual macOS guest and never promises Linux tools or offline networking", () => {
  const instructions = instructionsFor("isolated-desktop", "darwin");
  expect(instructions).toContain("private macOS VM");
  expect(instructions).toContain("one thread slot");
  expect(instructions).toContain("NAT networking");
  expect(instructions).toContain("close_desktop");
  expect(instructions).toContain("No project, host home");
  expect(instructions).not.toContain("Mousepad");
  expect(instructions).not.toContain("four thread slots");
});

const off = { allowPixelInput: false };
const on = { allowPixelInput: true };
const windowTarget = { kind: "window", pid: 4, window_id: 42 };

for (const name of [
  "click",
  "double_click",
  "right_click",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "scroll",
]) {
  it(`${name} accepts element or exact-window input and refuses desktop, foreground, or unbound input`, () => {
    for (const args of [
      { target: windowTarget },
      { element_token: "s01234567:1" },
      { pid: 4, element_index: 1, snapshot_id: "s01234567", window_id: 42 },
    ]) {
      // double_click/right_click/click need an element, keyboard tools accept a window target.
      const needsElement = ["click", "double_click", "right_click"].includes(name);
      if (needsElement && "target" in args) continue;
      expect(backgroundRefusal(tool(name), args, off)).toBeUndefined();
    }
    for (const args of [
      {},
      { pid: 0 },
      { pid: "4" },
      { element_token: "t", scope: "desktop" },
      { element_token: "t", delivery_mode: "foreground" },
      { element_token: "t", delivery_mode: "auto" },
      { target: { kind: "desktop", display_id: "primary" } },
      { target: { kind: "window", pid: "4", window_id: 42 } },
      { element_token: "t", session: "foreign-session" },
    ]) {
      expect(backgroundRefusal(tool(name), args, on)).toBeTypeOf("string");
    }
  });
}

it("refuses pixel input unless the setting allows it", () => {
  for (const [name, args] of [
    ["click", { pid: 4, x: 1, y: 2 }],
    ["double_click", { pid: 4, x: 1, y: 2 }],
    ["right_click", { pid: 4, x: 1, y: 2 }],
    ["scroll", { pid: 4, x: 1, y: 2, direction: "down" }],
    ["drag", { pid: 4, from_x: 1, from_y: 2, to_x: 3, to_y: 4 }],
    ["click", { pid: 4, element_token: "t", x: 1, y: 2 }],
  ] as const) {
    expect(backgroundRefusal(tool(name), args, off)).toContain("get_window_state");
    expect(backgroundRefusal(tool(name), args, on)).toBeUndefined();
  }
});

it("requires element or exact-window targets for bare-pid input", () => {
  for (const name of ["click", "double_click", "right_click", "type_text", "press_key", "hotkey"])
    expect(backgroundRefusal(tool(name), { pid: 4 }, off)).toBeTypeOf("string");
  expect(backgroundRefusal(tool("scroll"), { pid: 4, direction: "down" }, off)).toBeTypeOf(
    "string",
  );
  expect(backgroundRefusal(tool("hotkey"), { pid: 4 }, on)).toContain("bare pid");
  expect(backgroundRefusal(tool("hotkey"), { target: windowTarget }, off)).toBeUndefined();
});

for (const name of ["type_text", "press_key", "hotkey", "set_value", "scroll"]) {
  it(`${name} accepts both exact-window forms and snapshot elements regardless of pixel opt-in`, () => {
    for (const options of [off, on]) {
      for (const args of [
        { target: windowTarget },
        { pid: 4, window_id: 42 },
        { element_index: 1, snapshot_id: "s01234567" },
      ])
        expect(backgroundRefusal(tool(name), args, options)).toBeUndefined();
      for (const args of [
        { pid: 4 },
        { pid: 4, window_id: 0 },
        { pid: -4, window_id: 42 },
        { pid: 4, window_id: 1.5 },
        { pid: 4, window_id: "42" },
        { target: { kind: "window", pid: 4, window_id: 0 } },
      ])
        expect(backgroundRefusal(tool(name), args, options)).toBeTypeOf("string");
    }
  });
}

for (const name of ["type_text", "press_key", "hotkey", "set_value"]) {
  it(`${name} gates pixels without letting pixels replace exact targeting`, () => {
    const pixelArgs = { pid: 4, x: 1, y: 2 };
    expect(backgroundRefusal(tool(name), pixelArgs, on)).toContain("bare pid");
    for (const target of [{ window_id: 42 }, { element_token: "t" }]) {
      const args = { ...pixelArgs, ...target };
      expect(backgroundRefusal(tool(name), args, off)).toContain("get_window_state");
      expect(backgroundRefusal(tool(name), args, on)).toBeUndefined();
    }
  });
}

it("requires elements or opted-in pixels for pointer tools even with exact windows", () => {
  for (const name of ["click", "double_click", "right_click"])
    for (const options of [off, on])
      expect(backgroundRefusal(tool(name), { target: windowTarget }, options)).toContain(
        "element_token",
      );
});

it("keeps agent cursor overlay moves allowed", () => {
  expect(backgroundRefusal(tool("move_cursor"), { pid: 4, x: 1, y: 2 }, off)).toBeUndefined();
  expect(backgroundRefusal(tool("move_cursor"), { x: 1, y: 2, scope: "desktop" }, on)).toBeTypeOf(
    "string",
  );
});

it("always forwards background delivery to tools that accept it", () => {
  const forwarded = applyBackgroundPolicy(tool("click"), { element_token: "t" }, off);
  expect(forwarded.refusal).toBeUndefined();
  if (forwarded.refusal !== undefined) throw new Error(forwarded.refusal);
  expect(forwarded.args).toEqual({ element_token: "t", delivery_mode: "background" });
  const without = applyBackgroundPolicy(tool("set_value", {}), { element_token: "t" }, off);
  expect(without.refusal).toBeUndefined();
  if (without.refusal !== undefined) throw new Error(without.refusal);
  expect(without.args).toEqual({ element_token: "t" });
});

it("no longer exposes driver configuration and recording tools", () => {
  for (const name of [
    "check_permissions",
    "set_agent_cursor_enabled",
    "set_agent_cursor_motion",
    "set_agent_cursor_theme",
    "start_recording",
    "stop_recording",
    "get_recording_state",
  ]) {
    expect(isAllowedTool(tool(name), "background-only")).toBe(false);
    expect(backgroundRefusal(tool(name), {}, on)).toContain("not a background operation");
  }
  expect(isAllowedTool(tool("get_agent_cursor_state"), "background-only")).toBe(true);
});

it("allows desktop observation without allowing desktop input", () => {
  expect(
    backgroundRefusal(
      {
        name: "get_desktop_state",
        description: "Capture.",
        inputSchema: { type: "object" },
        readOnly: true,
      },
      { max_image_dimension: 64 },
    ),
  ).toBeUndefined();
});

it("refuses unreviewed operations even if their catalog claims they are read-only", () => {
  expect(
    backgroundRefusal(
      {
        name: "new_driver_operation",
        description: "Unknown.",
        inputSchema: { type: "object" },
        readOnly: true,
      },
      {},
    ),
  ).toContain("not a background operation");
});

it("explains off-Space failures without suggesting foreground delivery", () => {
  const note = offSpaceNote({
    isError: true,
    text: "ax_window_unresolved: retry with delivery_mode:foreground",
    structured: undefined,
  });
  expect(note).toContain("another macOS Space");
  expect(note).toContain("do not retry");
  expect(offSpaceNote({ isError: false, text: "ok", structured: { off_space: true } })).toContain(
    "another macOS Space",
  );
  expect(offSpaceNote({ isError: true, text: "stale element", structured: {} })).toBeUndefined();
  expect(
    offSpaceNote({ isError: false, text: "off_space mentioned", structured: {} }),
  ).toBeUndefined();
});
