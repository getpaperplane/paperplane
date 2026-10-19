import { describe, expect, it } from "vite-plus/test";

import { summarizeProviderExtensions } from "./providerExtensionsSummary";

const data = (extensions: number, warnings: number, compatibilityWarnings?: number) => ({
  extensions: Array.from({ length: extensions }),
  warnings: Array.from({ length: warnings }),
  compatibilityWarnings:
    compatibilityWarnings === undefined ? undefined : Array.from({ length: compatibilityWarnings }),
});

describe("summarizeProviderExtensions", () => {
  it("reports loading and error before data arrives", () => {
    expect(summarizeProviderExtensions({ data: null, error: null, isPending: true })).toBe(
      "Loading…",
    );
    expect(summarizeProviderExtensions({ data: null, error: "boom", isPending: false })).toBe(
      "Error",
    );
  });

  it("shows only the count without issues", () => {
    expect(summarizeProviderExtensions({ data: data(12, 0), error: null, isPending: false })).toBe(
      "12",
    );
  });

  it("pluralizes issues across warnings and compatibility warnings", () => {
    expect(summarizeProviderExtensions({ data: data(3, 1), error: null, isPending: false })).toBe(
      "3 · 1 issue",
    );
    expect(
      summarizeProviderExtensions({ data: data(3, 1, 1), error: null, isPending: false }),
    ).toBe("3 · 2 issues");
  });
});
