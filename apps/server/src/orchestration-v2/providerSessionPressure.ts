import { SMALL_HOST_BYTES } from "../process/roveMemoryBudget.ts";

const GIB = 1024 ** 3;

export function idleTimeoutForHost(totalBytes: number): number {
  return (totalBytes <= SMALL_HOST_BYTES ? 5 : 30) * 60 * 1000;
}

export function isUnderMemoryPressure(memory: {
  readonly totalMemoryBytes: number;
  readonly availableMemoryBytes: number;
}): boolean {
  return memory.availableMemoryBytes < Math.max(GIB, memory.totalMemoryBytes * 0.15);
}
