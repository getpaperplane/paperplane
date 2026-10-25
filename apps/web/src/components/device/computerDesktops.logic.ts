import type { ComputerDesktop, ComputerDesktopsState } from "@getpaperplane/contracts";

import type { ComputerTabTarget } from "~/rightPanelStore";

/**
 * Which note the Computers group shows: why there is no desktop on a host
 * that drives the real Mac or PC, a hint that one appears once an agent uses
 * computer use, or nothing when computer use is off or unavailable.
 */
export function computerPickerNote(input: {
  readonly mode: ComputerDesktopsState["mode"];
  readonly enabled: boolean;
  readonly desktopCount: number;
}): "host" | "empty" | null {
  if (!input.enabled || input.desktopCount > 0) return null;
  if (input.mode === "host") return "host";
  return input.mode === "isolated" ? "empty" : null;
}

export const computerTabTarget = (desktop: ComputerDesktop): ComputerTabTarget => ({
  kind: "computer",
  desktopId: desktop.id,
  desktopKind: desktop.kind,
  name: desktop.name,
});

/**
 * Desktops that appeared since the last snapshot of a thread. The first
 * snapshot only records a baseline, so desktops that already existed when the
 * thread opened never pop up again after the user closed them.
 */
export function newComputerDesktops(
  previous: ReadonlySet<string> | undefined,
  desktops: ReadonlyArray<ComputerDesktop>,
): ReadonlyArray<ComputerDesktop> {
  if (!previous) return [];
  return desktops.filter((desktop) => !previous.has(desktop.id));
}

// Characters a US keyboard types with Shift. Sending Shift around them matches
// what a real keyboard does, so VNC servers that map keysyms to key codes agree.
const SHIFTED = new Set('~!@#$%^&*()_+{}|:"<>?');

/**
 * Key presses that type `text` on a desktop. Printable ASCII keysyms equal
 * their code points. `null` for anything else, including newlines: typing
 * never presses Return, so nothing runs until the user does.
 */
export function typingKeys(
  text: string,
): ReadonlyArray<{ readonly keysym: number; readonly shift: boolean }> | null {
  const keys: Array<{ keysym: number; shift: boolean }> = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code > 0x7e) return null;
    keys.push({ keysym: code, shift: (char >= "A" && char <= "Z") || SHIFTED.has(char) });
  }
  return keys;
}
