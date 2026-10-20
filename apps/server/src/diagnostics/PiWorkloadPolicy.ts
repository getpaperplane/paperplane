// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import { executeProcessControl, parseProcessBudgetMiB } from "./ProcessBudget.ts";
import { SMALL_HOST_BYTES } from "../process/roveMemoryBudget.ts";

export interface PiWorkloadConfig {
  readonly memoryMiB: number | "auto";
  readonly ownerUnit: string;
  /** Override automatic slot sizing, primarily for isolated integration tests. */
  readonly foregroundSlots?: number;
  /** Isolated integration tests use a separate pool. Production shares one OS-user pool. */
  readonly pool?: string;
}

/** Bound concurrent shells by both CPU capacity and the shared RAM ceiling. */
export function foregroundSlots({
  cpus,
  ceilingBytes,
}: {
  readonly cpus: number;
  readonly ceilingBytes: number;
}) {
  return Math.max(1, Math.min(4, Math.floor(cpus / 2), Math.floor(ceilingBytes / (2 * 1024 ** 3))));
}

/** Explicit settings fail closed. Auto only enables on small, systemd-capable Linux hosts. */
export async function resolvePiWorkloadMemory(
  mode: "auto" | "on" | "off" | undefined,
  configured: string,
  environment: NodeJS.ProcessEnv,
  platform = process.platform,
  totalMemory = NodeOS.totalmem(),
): Promise<{ kind: "auto" } | { kind: "explicit"; mib: number } | undefined> {
  const override = environment.ROVE_PI_MEMORY_BUDGET_MIB;
  if (mode === "off" && override === undefined) return undefined;
  const explicit = override !== undefined || mode === "on";
  if (
    !explicit &&
    (platform !== "linux" || totalMemory > SMALL_HOST_BYTES || totalMemory < 768 * 1024 ** 2)
  )
    return undefined;
  if (platform !== "linux")
    throw new Error("Pi workload protection requires Linux with user systemd.");
  try {
    await executeProcessControl("systemctl", ["--user", "show-environment"]);
    await executeProcessControl("flock", ["--version"]);
  } catch (error) {
    if (explicit) throw error;
    return undefined;
  }
  const value = override ?? configured;
  // Older settings persisted the old default even when no limit was chosen.
  if (override === undefined && (value === "auto" || (mode !== "on" && value === "2048"))) {
    return { kind: "auto" };
  }
  const memory = parseProcessBudgetMiB(value);
  if (memory < 384) throw new Error("Pi workload protection needs at least 384 MiB.");
  return { kind: "explicit", mib: memory };
}
