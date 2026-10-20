export const SMALL_HOST_BYTES = 8 * 1024 ** 3;
const MiB = 1024 ** 2;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Leave RAM for the OS and control plane, with bounded swap for agent work. */
export function roveMemoryBudget(totalBytes: number, swapBytes: number) {
  const total = totalBytes / MiB;
  const max = Math.floor(total - clamp(total / 4, 1536, 4096));
  return {
    max: Math.max(0, max) * MiB,
    swapMax: Math.floor(Math.min(swapBytes / MiB, total / 2)) * MiB,
  };
}

export interface SliceLimits {
  readonly max: number;
}

/** Never force an immediate OOM when another server asks to shrink a live slice. */
export function nextSliceLimits({
  current,
  requested,
  populated,
  memoryCurrent,
}: {
  readonly current: SliceLimits;
  readonly requested: SliceLimits;
  readonly populated: boolean;
  readonly memoryCurrent: number;
}) {
  const deferred = requested.max < current.max && populated && memoryCurrent >= requested.max;
  return {
    max: deferred ? current.max : requested.max,
    deferred,
  };
}
