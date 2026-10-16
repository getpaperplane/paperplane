import { describe, expect, it } from "vite-plus/test";

import { structurallyEqual } from "./useStructuralValue";

describe("structurallyEqual", () => {
  it("compares plain data by content", () => {
    expect(
      structurallyEqual({ a: [1, { b: "x" }], c: null }, { a: [1, { b: "x" }], c: null }),
    ).toBe(true);
    expect(structurallyEqual([], [])).toBe(true);
    expect(structurallyEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(structurallyEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(structurallyEqual({ 0: 1 }, [1])).toBe(false);
  });

  it("compares class instances and functions by identity", () => {
    const callback = () => {};
    expect(structurallyEqual({ callback }, { callback })).toBe(true);
    expect(structurallyEqual({ callback }, { callback: () => {} })).toBe(false);
    expect(structurallyEqual(new Date(0), new Date(0))).toBe(false);
  });
});
