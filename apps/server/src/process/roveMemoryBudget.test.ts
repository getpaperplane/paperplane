import { describe, expect, it } from "vite-plus/test";
import { nextSliceLimits, roveMemoryBudget } from "./roveMemoryBudget.ts";

const MiB = 1024 ** 2;
describe("Paperplane memory budget", () => {
  it.each([
    [2048, 512, 1024],
    [5928, 4392, 2964],
    [8192, 6144, 4096],
    [16384, 12288, 4096],
    [65536, 61440, 4096],
  ])("reserves OS and server RAM on a %i MiB host", (total, max, swapMax) => {
    expect(roveMemoryBudget(total * MiB, 4096 * MiB)).toEqual({
      max: max * MiB,
      swapMax: swapMax * MiB,
    });
  });
  it("does not invent swap", () => {
    expect(roveMemoryBudget(8192 * MiB, 0).swapMax).toBe(0);
  });
});

describe("safe live slice resizing", () => {
  const current = { max: 1000 };
  it.each([
    [true, 1200, 1200, false],
    [true, 499, 500, false],
    [true, 500, 1000, true],
    [true, 900, 1000, true],
    [false, 900, 500, false],
  ])("populated=%s usage=%i requested/result=%i", (populated, memoryCurrent, max, deferred) => {
    const requested = { max: max === 1200 ? 1200 : 500 };
    expect(nextSliceLimits({ current, requested, populated, memoryCurrent })).toEqual({
      max,
      deferred,
    });
  });
  it("resets limits to infinity while populated", () => {
    expect(
      nextSliceLimits({
        current,
        requested: { max: Infinity },
        populated: true,
        memoryCurrent: 2000,
      }),
    ).toEqual({ max: Infinity, deferred: false });
  });
});
