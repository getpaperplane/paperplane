import { describe, expect, it } from "vite-plus/test";
import { BUILT_IN_THEMES, getThemeColorsForAppearance } from "@getpaperplane/shared/themePalettes";

import { themeColorToNativeColor } from "../../lib/mobileTheme";

import { buildGhosttyThemeConfig, getMobileTerminalTheme } from "./terminalTheme";

describe("getMobileTerminalTheme", () => {
  it("uses the shared default light terminal colors", () => {
    expect(getMobileTerminalTheme("paperplane", "light")).toMatchObject({
      background: "#f6f5f0",
      foreground: "#1c2332",
      cursorForeground: "#26384e",
      cursorBackground: "#f6f5f0",
    });
  });

  it("uses the shared default dark terminal colors", () => {
    expect(getMobileTerminalTheme("paperplane", "dark")).toMatchObject({
      background: "#0f131b",
      foreground: "#ece7da",
      cursorForeground: "#8eaef7",
      cursorBackground: "#0f131b",
    });
  });
  it("applies the selected palette without replacing ANSI status colors", () => {
    const standard = getMobileTerminalTheme("paperplane", "dark");
    const ocean = getMobileTerminalTheme("ocean", "dark");

    expect(ocean.background).not.toBe(standard.background);
    expect(ocean.cursorForeground).not.toBe(standard.cursorForeground);
    expect(ocean.palette).toEqual(standard.palette);
  });

  it("uses the canonical desktop terminal roles for built-in themes", () => {
    const theme = BUILT_IN_THEMES.find((candidate) => candidate.id === "ocean")!;
    const colors = getThemeColorsForAppearance(theme, "dark")!;
    const terminal = getMobileTerminalTheme("ocean", "dark");

    expect(terminal.background).toBe(themeColorToNativeColor(colors.terminalBackground));
    expect(terminal.foreground).toBe(themeColorToNativeColor(colors.terminalForeground));
    expect(terminal.cursorForeground).toBe(themeColorToNativeColor(colors.terminalCursor));
  });
});

describe("buildGhosttyThemeConfig", () => {
  it("serializes theme colors into a ghostty config file", () => {
    const config = buildGhosttyThemeConfig(getMobileTerminalTheme("paperplane", "dark"));

    expect(config).toContain("background = #0f131b");
    expect(config).toContain("foreground = #ece7da");
    expect(config).toContain("cursor-color = #8eaef7");
    expect(config).toContain("palette = 0=#141415");
    expect(config).toContain("palette = 15=#c6c6c8");
    expect(config.endsWith("\n")).toBe(true);
  });
});
