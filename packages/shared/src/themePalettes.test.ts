import { describe, expect, it } from "vite-plus/test";
import {
  BUILT_IN_THEME_IDS,
  BUILT_IN_THEMES,
  MOBILE_THEME_IDS,
  PLUM_THEME,
  RESERVED_THEME_IDS,
  THEME_COLOR_ROLES,
  getThemeColorsForAppearance,
} from "./themePalettes.ts";

describe("built-in theme identity", () => {
  it("resolves saved Plum preferences to the same palette", () => {
    const palette = BUILT_IN_THEMES.find((theme) => theme.id === "plum");
    expect(palette).toBe(PLUM_THEME);
    expect(palette?.label).toBe("Plum");
    expect(BUILT_IN_THEME_IDS).toContain("plum");
    expect(MOBILE_THEME_IDS).toContain("plum");
    expect(RESERVED_THEME_IDS.has("plum-dark")).toBe(true);
  });

  it.each(BUILT_IN_THEMES)(
    "keeps every color role and distinct search highlights in $label",
    (theme) => {
      for (const appearance of ["light", "dark"] as const) {
        const colors = getThemeColorsForAppearance(theme, appearance);
        expect(colors).not.toBeNull();
        for (const role of THEME_COLOR_ROLES) expect(colors?.[role]).toBeTruthy();
        expect(colors?.searchMatchBackground).not.toBe(colors?.codeBackground);
        expect(colors?.searchMatchActiveBackground).not.toBe(colors?.searchMatchBackground);
      }
    },
  );
});
