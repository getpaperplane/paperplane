import type { HostHealthReport } from "@rove-code/contracts";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** Formats a used/total pair in the total's unit, e.g. "2.1 / 4.3 GiB". */
function formatBytePair(used: number, total: number): string {
  const [divisor, unit] = total >= GIB ? [GIB, "GiB"] : [MIB, "MiB"];
  const digits = divisor === GIB ? 1 : 0;
  return `${(used / divisor).toFixed(digits)} / ${(total / divisor).toFixed(digits)} ${unit}`;
}

/** Formats a single host-memory amount, e.g. "1.2 GiB" or "640 MiB". */
function formatMemoryBytes(bytes: number): string {
  return bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GiB` : `${Math.round(bytes / MIB)} MiB`;
}

/** The composer notice for a host under memory pressure, or null when it is fine. */
export function hostMemoryNotice(report: HostHealthReport): { readonly freeLabel: string } | null {
  if (!report.memoryPressure) return null;
  return { freeLabel: `${formatMemoryBytes(report.availableMemoryBytes)} free` };
}

/** "1.2 / 7.8 GiB available". */
export function formatHostMemory(report: HostHealthReport): string {
  return `${formatBytePair(report.availableMemoryBytes, report.totalMemoryBytes)} available`;
}

/** "0.4 / 2.0 GiB free", "none" without swap, or null where swap is not reported. */
export function formatHostSwap(report: HostHealthReport): string | null {
  if (report.swapTotalBytes === null) return null;
  if (report.swapTotalBytes === 0) return "none";
  return `${formatBytePair(report.swapFreeBytes ?? 0, report.swapTotalBytes)} free`;
}

/** Usage of Paperplane's shared memory ceiling, or null when the host has no ceiling. */
export function formatRoveCeiling(report: HostHealthReport): string | null {
  const memory = report.roveMemory;
  if (memory === null) return null;
  const used =
    memory.limitBytes === null
      ? `${formatMemoryBytes(memory.currentBytes)} used · unlimited`
      : `${formatBytePair(memory.currentBytes, memory.limitBytes)} used`;
  if (memory.swapCurrentBytes === null) return used;
  const swap =
    memory.swapLimitBytes === null
      ? formatMemoryBytes(memory.swapCurrentBytes)
      : formatBytePair(memory.swapCurrentBytes, memory.swapLimitBytes);
  return `${used} · swap ${swap}`;
}

/** Percent of Paperplane's ceiling in use (0-100), or null when there is no finite ceiling. */
export function roveCeilingPercent(report: HostHealthReport): number | null {
  const memory = report.roveMemory;
  if (memory === null || memory.limitBytes === null || memory.limitBytes === 0) return null;
  return Math.min(100, (memory.currentBytes / memory.limitBytes) * 100);
}
