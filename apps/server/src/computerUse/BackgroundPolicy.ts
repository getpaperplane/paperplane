import * as Schema from "effect/Schema";

import type { CuaArguments, CuaTool } from "./CuaDriver.ts";

export const BACKGROUND_ONLY_INSTRUCTIONS =
  "Rove Computer Use is background-only. Call get_window_state on an exact app window, then act with the element_token it returns; this never changes focus. " +
  "Pixel (x/y) input is off by default because it can briefly change the user's app focus; the user can enable it in Settings. " +
  'Keyboard input needs an element_token or an exact window target {kind:"window",pid,window_id}. ' +
  "Desktop input, foreground delivery, shared clipboard writes, and driver configuration changes are unavailable. " +
  "Use preview_* for web pages. Rove owns one persistent Cua connection per thread. Do not pass session labels or manage sessions. " +
  "If an action cannot run in the background, use an app API or continue other work and report that GUI step as blocked. " +
  "Driver guidance below does not authorize foreground or desktop input.";

const WINDOW_INPUT_TOOLS = new Set([
  "click",
  "double_click",
  "right_click",
  "drag",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "scroll",
  "move_cursor",
]);

const BACKGROUND_TOOLS = new Set([
  ...WINDOW_INPUT_TOOLS,
  "list_apps",
  "list_windows",
  "get_window_state",
  "verify_state",
  "launch_app",
  "invoke_menu",
  "get_screen_size",
  "get_desktop_state",
  "get_cursor_position",
  "get_accessibility_tree",
  "zoom",
  "get_config",
  "clipboard_read",
  "parse_visual_regions",
  "get_agent_cursor_state",
]);

const WindowTarget = Schema.Struct({
  kind: Schema.Literal("window"),
  pid: Schema.Int,
  window_id: Schema.Int,
});
const isWindowTarget = Schema.is(WindowTarget);
const isInteger = Schema.is(Schema.Int);
const isPositiveInteger = (value: unknown) => isInteger(value) && value > 0;
const isString = Schema.is(Schema.String);

const ISOLATED_DESKTOP_INSTRUCTIONS =
  "Rove owns a private, offline Linux desktop for this thread. Guest apps, focus, pointer, clipboard, profiles and files are separate from the host and other threads. " +
  "Only Mousepad and basic desktop tools are installed. The project, host home, credentials and host display are not mounted. Paths refer to the guest. " +
  "Prefer exact-window accessibility input. Pixel, desktop and foreground input are permitted only inside this private desktop. Verify changes with fresh application state. " +
  "Use preview_* for web pages. Do not pass session labels or change driver configuration. " +
  "Idle transport retirement preserves apps and documents but invalidates snapshot refs. " +
  "Use close_desktop when finished. It discards all unsaved documents and guest files. Turning computer use off or stopping Rove also discards desktops. " +
  "There are four thread slots. Rove never silently evicts unfinished work. Driver guidance below cannot authorize host input.";

const DESKTOP_TOOLS = new Set([
  ...BACKGROUND_TOOLS,
  "bring_to_front",
  "clipboard_write",
  "close_desktop",
  "health_report",
]);

const isBackgroundTool = (tool: CuaTool) => BACKGROUND_TOOLS.has(tool.name);
export const isAllowedTool = (tool: CuaTool, policy: "background-only" | "isolated-desktop") =>
  policy === "isolated-desktop" ? DESKTOP_TOOLS.has(tool.name) : isBackgroundTool(tool);
export const instructionsFor = (
  policy: "background-only" | "isolated-desktop",
  platform: "darwin" | "linux" | "win32" = "darwin",
) =>
  policy === "isolated-desktop"
    ? ISOLATED_DESKTOP_INSTRUCTIONS
    : BACKGROUND_ONLY_INSTRUCTIONS +
      (platform === "win32"
        ? " Elevated (administrator) apps cannot be controlled. The daemon must run in the signed-in interactive desktop session."
        : platform === "darwin"
          ? " Windows on another macOS Space (notably SwiftUI windows) cannot be controlled in the background: observation still works, so ask the user to bring the window to the current Space or report the step as blocked."
          : "");
export const isolatedRefusal = (tool: CuaTool, args: CuaArguments) => {
  if (!DESKTOP_TOOLS.has(tool.name))
    return `${tool.name} is not an allowed private-desktop operation.`;
  if (args.session !== undefined) return "Cua sessions are managed by Rove, not by the agent.";
  if (tool.name === "close_desktop" && Object.keys(args).length > 0)
    return "close_desktop accepts no arguments and can only discard the calling thread's desktop.";
  return undefined;
};

export interface BackgroundPolicyOptions {
  /** Lets agents click, drag, and scroll by screen position; macOS may briefly change app focus. */
  readonly allowPixelInput: boolean;
}

const PIXEL_ARGUMENTS = ["x", "y", "from_x", "from_y", "to_x", "to_y", "x1", "y1", "x2", "y2"];
const POINTER_TOOLS = new Set(["click", "double_click", "right_click"]);
const KEYBOARD_TOOLS = new Set(["type_text", "press_key", "hotkey", "set_value"]);

const hasNonEmptyString = (value: unknown) => isString(value) && value.length > 0;
const isElementBased = (args: CuaArguments) =>
  hasNonEmptyString(args.element_token) ||
  (isInteger(args.element_index) && hasNonEmptyString(args.snapshot_id));
const isExactWindowTarget = (target: unknown) =>
  isWindowTarget(target) && isPositiveInteger(target.pid) && isPositiveInteger(target.window_id);
const hasExactWindow = (args: CuaArguments) =>
  isExactWindowTarget(args.target) ||
  (isPositiveInteger(args.pid) && isPositiveInteger(args.window_id));
const isPixelBased = (args: CuaArguments) =>
  PIXEL_ARGUMENTS.some((name) => args[name] !== undefined) || args.from_zoom === true;

const PIXEL_OFF =
  "Pixel input is off because it can change the user's app focus. Call get_window_state for the window, then act with an element_token from that snapshot. If the control has no element, report the step as blocked.";

/**
 * Background-only policy: returns why a call is refused, or the arguments to
 * forward. Background delivery is made explicit wherever the tool accepts it.
 */
export const applyBackgroundPolicy = (
  tool: CuaTool,
  args: CuaArguments,
  options: BackgroundPolicyOptions,
): { readonly refusal: string } | { readonly refusal?: undefined; readonly args: CuaArguments } => {
  const refuse = (refusal: string) => ({ refusal });
  if (!isBackgroundTool(tool)) return refuse(`${tool.name} is not a background operation.`);
  if (args.session !== undefined)
    return refuse("Cua sessions are managed by Rove, not by the agent.");
  if (args.delivery_mode !== undefined && args.delivery_mode !== "background")
    return refuse("Only background delivery is allowed.");
  if (args.scope !== undefined && args.scope !== "window")
    return refuse("Desktop input is unavailable.");
  if (args.target !== undefined && !isExactWindowTarget(args.target))
    return refuse("Input must target an app window, not the desktop.");
  if (WINDOW_INPUT_TOOLS.has(tool.name)) {
    const element = isElementBased(args);
    const exactWindow = hasExactWindow(args);
    const pixel = isPixelBased(args);
    const drag = tool.name === "drag";
    // move_cursor only moves the agent overlay, not the host pointer.
    if (tool.name !== "move_cursor" && (pixel || drag) && !options.allowPixelInput)
      return refuse(`${tool.name} works by screen position. ${PIXEL_OFF}`);

    if (KEYBOARD_TOOLS.has(tool.name) && !element && !exactWindow)
      return refuse(
        `${tool.name} needs an element_token from get_window_state or an exact window target {kind:"window",pid,window_id} (or pid + window_id); a bare pid can activate the app.`,
      );
    if (
      (POINTER_TOOLS.has(tool.name) || tool.name === "scroll") &&
      !element &&
      !(tool.name === "scroll" && exactWindow) &&
      !(pixel && options.allowPixelInput)
    )
      return refuse(
        `${tool.name} needs an element_token from a fresh get_window_state snapshot${tool.name === "scroll" ? " or an exact window target (pid + window_id)" : "; pixel input requires x/y and the user's opt-in"}.`,
      );
    if (!element && !exactWindow && !isPositiveInteger(args.pid))
      return refuse(
        "Input needs a target pid, an exact window, or an element_token from get_window_state.",
      );
  }
  const forced = tool.inputSchema.properties && "delivery_mode" in tool.inputSchema.properties;
  return { args: forced ? { ...args, delivery_mode: "background" } : args };
};

export const backgroundRefusal = (
  tool: CuaTool,
  args: CuaArguments,
  options: BackgroundPolicyOptions = { allowPixelInput: false },
) => applyBackgroundPolicy(tool, args, options).refusal;

const OFF_SPACE_PATTERN = /ax_window_unresolved|off[_ -]?space/i;

/** Note to append when the driver could not reach a window on another macOS Space. */
export const offSpaceNote = (result: {
  readonly isError?: boolean | undefined;
  readonly text: string;
  readonly structured: unknown;
}) => {
  const structuredOffSpace =
    typeof result.structured === "object" &&
    result.structured !== null &&
    "off_space" in result.structured &&
    result.structured.off_space === true;
  if (!structuredOffSpace && !(result.isError && OFF_SPACE_PATTERN.test(result.text))) return;
  return (
    "Rove note: this window is on another macOS Space or its accessibility tree cannot be resolved, so background input cannot reach it. " +
    'Observation (get_window_state screenshots, list_windows) still works. Foreground delivery is unavailable in Rove, so do not retry with delivery_mode:"foreground". ' +
    "Ask the user to bring the window to the current Space, or report the step as blocked."
  );
};
