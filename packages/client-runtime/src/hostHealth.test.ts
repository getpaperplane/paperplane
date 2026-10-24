import type { HostHealthReport } from "@getpaperplane/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatHostSwap,
  formatRoveCeiling,
  hostMemoryNotice,
  roveCeilingPercent,
} from "./hostHealth.ts";

const GIB = 1024 ** 3;

function report(overrides: Partial<HostHealthReport> = {}): HostHealthReport {
  return {
    sampledAt: 0,
    totalMemoryBytes: 8 * GIB,
    availableMemoryBytes: 1.2 * GIB,
    swapTotalBytes: 2 * GIB,
    swapFreeBytes: 0.5 * GIB,
    memoryPressure: true,
    roveMemory: null,
    findings: [],
    ...overrides,
  };
}

describe("hostMemoryNotice", () => {
  it("is null without memory pressure", () => {
    expect(hostMemoryNotice(report({ memoryPressure: false }))).toBeNull();
  });

  it("labels free memory, switching to MiB under 1 GiB", () => {
    expect(hostMemoryNotice(report())?.freeLabel).toBe("1.2 GiB free");
    expect(hostMemoryNotice(report({ availableMemoryBytes: 640 * 1024 ** 2 }))?.freeLabel).toBe(
      "640 MiB free",
    );
  });
});

describe("formatRoveCeiling", () => {
  it("is null when the host has no ceiling", () => {
    expect(formatRoveCeiling(report())).toBeNull();
  });

  it("shows usage against the limit and swap", () => {
    const value = report({
      roveMemory: {
        limitBytes: 4.3 * GIB,
        currentBytes: 2.1 * GIB,
        swapLimitBytes: 2.9 * GIB,
        swapCurrentBytes: 0.4 * GIB,
        oomKills: 0,
      },
    });
    expect(formatRoveCeiling(value)).toBe("2.1 / 4.3 GiB used · swap 0.4 / 2.9 GiB");
    expect(roveCeilingPercent(value)).toBeCloseTo((2.1 / 4.3) * 100);
  });

  it("marks an unlimited ceiling and has no percent", () => {
    const value = report({
      roveMemory: {
        limitBytes: null,
        currentBytes: 2.1 * GIB,
        swapLimitBytes: null,
        swapCurrentBytes: null,
        oomKills: 0,
      },
    });
    expect(formatRoveCeiling(value)).toBe("2.1 GiB used · unlimited");
    expect(roveCeilingPercent(value)).toBeNull();
  });
});

describe("formatHostSwap", () => {
  it("distinguishes unreported, absent, and present swap", () => {
    expect(formatHostSwap(report({ swapTotalBytes: null, swapFreeBytes: null }))).toBeNull();
    expect(formatHostSwap(report({ swapTotalBytes: 0, swapFreeBytes: 0 }))).toBe("none");
    expect(formatHostSwap(report())).toBe("0.5 / 2.0 GiB free");
  });
});
