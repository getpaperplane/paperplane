import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  customThemeNames,
  getGeneratedUniwindThemeOutputs,
  renderDefaultThemeVariablesJSON,
  renderUniwindThemesCSS,
} from "./generate-uniwind-themes.mts";
import { readDefaultMobileThemeVariables } from "../src/lib/mobileTheme.test-support";

describe("generate mobile Uniwind themes", () => {
  it("keeps the committed outputs current", () => {
    const staleOutputs = getGeneratedUniwindThemeOutputs()
      .filter(
        ([filename, contents]) =>
          !NodeFS.existsSync(filename) || NodeFS.readFileSync(filename, "utf8") !== contents,
      )
      .map(([filename]) => NodePath.relative(import.meta.dirname, filename));

    expect(
      staleOutputs,
      "Run `vp run --filter @getpaperplane/mobile generate` and commit the generated outputs.",
    ).toEqual([]);
  });

  it("registers every custom palette for both appearances", () => {
    expect(customThemeNames).toEqual([
      "plum-light",
      "plum-dark",
      "grove-light",
      "grove-dark",
      "ocean-light",
      "ocean-dark",
      "ember-light",
      "ember-dark",
      "iris-light",
      "iris-dark",
    ]);

    const stylesheet = renderUniwindThemesCSS();
    for (const themeName of customThemeNames) {
      expect(stylesheet.match(new RegExp(`@variant ${themeName} \\{`, "gu"))).toHaveLength(1);
    }
  });

  it("keeps the default runtime bridge and generated CSS on the same palette", () => {
    const variables = JSON.parse(renderDefaultThemeVariablesJSON());

    expect(variables.light).toEqual(readDefaultMobileThemeVariables("light"));
    expect(variables.dark).toEqual(readDefaultMobileThemeVariables("dark"));
    expect(variables.light["--color-screen"]).toBe("#f6f5f0");
    expect(variables.light["--color-drawer"]).toBe("#ecebe3");
    expect(variables.dark["--color-screen"]).toBe("#0f131b");
    expect(variables.dark["--color-drawer"]).toBe("#070a0f");
    expect(Object.keys(variables.light)).toEqual(Object.keys(variables.dark));
  });

  it("gives every theme the same variables and a fixed Clerk palette for its appearance", () => {
    const css =
      NodeFS.readFileSync(NodePath.resolve(import.meta.dirname, "../global.css"), "utf8") +
      renderUniwindThemesCSS();
    const themes = new Map<string, Map<string, string>>(
      ["light", "dark", ...customThemeNames].map((name) => [name, new Map()]),
    );
    for (const [, name, body] of css.matchAll(/@variant ([\w-]+) \{([^}]+)\}/gu)) {
      const variables = themes.get(name!);
      for (const [, variable, value] of body!.matchAll(/(--[\w-]+):\s*([^;]+);/gu)) {
        variables?.set(variable!, value!.trim().toLowerCase());
      }
    }

    const lightVariables = themes.get("light")!;
    for (const [name, variables] of themes) {
      expect([...variables.keys()].sort(), name).toEqual([...lightVariables.keys()].sort());
      const isDark = name === "dark" || name.endsWith("-dark");
      expect(
        Object.fromEntries(
          [...variables].filter(([variable]) => variable.startsWith("--color-clerk-")),
        ),
        name,
      ).toEqual({
        "--color-clerk-page": isDark ? "#0f131b" : "#f6f5f0",
        "--color-clerk-foreground": isDark ? "#ece7da" : "#1c2332",
        "--color-clerk-foreground-muted": isDark ? "#9aa1ae" : "#5c6575",
        "--color-clerk-border": isDark ? "#21242a" : "#dcd9cd",
        "--color-clerk-danger": isDark ? "#f4a294" : "#a3321f",
      });
    }
  });
});
