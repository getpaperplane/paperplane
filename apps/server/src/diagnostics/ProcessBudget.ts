// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProcessRunner from "../processRunner.ts";
import { ensureRoveParentSlice } from "../process/agentScope.ts";
import { configureSlice, withSliceLock } from "../process/systemdSlice.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  Environment as HostProcessEnvironment,
  Platform as HostProcessPlatform,
  UserId as HostProcessUserId,
} from "@getpaperplane/shared/HostProcess";

const MemoryMiB = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 128, maximum: 1_048_576 }),
);

const PROVIDER_BUDGET_POOL = "app-rove-workloads.slice";

const decodeMemoryMiB = Schema.decodeUnknownSync(MemoryMiB);
const decodeTimeoutSeconds = Schema.decodeUnknownSync(
  Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 86_400 })),
);

export function parseProcessBudgetTimeout(value: string) {
  return decodeTimeoutSeconds(value);
}

export function parseProcessBudgetMiB(value: string) {
  return decodeMemoryMiB(value);
}

export class ProcessBudgetError extends Schema.TaggedError<ProcessBudgetError>()(
  "ProcessBudgetError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export function executeProcessControl(
  command: string,
  args: ReadonlyArray<string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(command, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error)
        reject(new Error(`${command} failed: ${stderr.trim() || error.message}`, { cause: error }));
      else resolve(stdout.trim());
    });
  });
}

/**
 * A Linux user-systemd scope preserves PID, stdio and inherited IPC descriptors.
 * All guarded instances share one memory budget; the server stays outside it.
 * Unsupported hosts fail closed rather than silently launching an unguarded worker.
 */
export const prepareBudgetedProcess = Effect.fn("prepareBudgetedProcess")(function* (
  command: string,
  args: ReadonlyArray<string>,
  memoryMiB: number | "auto",
  pool = PROVIDER_BUDGET_POOL,
  timeoutSeconds?: number,
  scopeOptions?: { readonly properties?: ReadonlyArray<string>; readonly collect?: boolean },
) {
  const platform = yield* HostProcessPlatform;
  const uid = yield* HostProcessUserId;
  const environment = yield* HostProcessEnvironment;
  if (platform !== "linux" || uid === undefined) {
    return yield* new ProcessBudgetError({
      detail: "Process budgets require Linux with a systemd user manager.",
    });
  }
  const bytes = yield* Effect.try({
    try: () =>
      memoryMiB === "auto" ? Infinity : parseProcessBudgetMiB(String(memoryMiB)) * 1024 * 1024,
    catch: (cause) => new ProcessBudgetError({ detail: "Invalid process memory budget.", cause }),
  });
  const deadline = yield* Effect.try({
    try: () =>
      timeoutSeconds === undefined
        ? []
        : [`--property=RuntimeMaxSec=${parseProcessBudgetTimeout(String(timeoutSeconds))}`],
    catch: (cause) => new ProcessBudgetError({ detail: "Invalid process deadline.", cause }),
  });
  const runtimeDirectory = environment.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
  const limits = yield* Effect.gen(function* () {
    // Only the production pool owns the shared host ceiling. Isolated pools (tests,
    // diagnostics) must never resize limits a live server on this OS user relies on.
    const parent =
      pool === PROVIDER_BUDGET_POOL ? yield* ensureRoveParentSlice() : { max: Infinity };
    const max = Math.min(bytes, parent.max);
    const poolLimits = yield* withSliceLock(
      runtimeDirectory,
      pool,
      configureSlice(pool, { max: memoryMiB === "auto" ? Infinity : max }, [
        "CPUQuota=",
        `MemorySwapMax=${memoryMiB === "auto" ? "infinity" : "0"}`,
      ]),
    );
    return { memoryMiB: Math.floor(Math.min(parent.max, poolLimits.max) / 1024 ** 2) };
  }).pipe(
    Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    Effect.mapError(
      (cause) => new ProcessBudgetError({ detail: "Workload pool setup failed.", cause }),
    ),
  );
  return { ...makeManagedProcess(command, args, pool, deadline, scopeOptions), ...limits };
});

/** An owner outside the command pool, still governed by the aggregate Paperplane budget. */
export function makeManagedProcess(
  command: string,
  args: ReadonlyArray<string>,
  pool = "app-rove-agents.slice",
  deadline: ReadonlyArray<string> = [],
  options?: { readonly properties?: ReadonlyArray<string>; readonly collect?: boolean },
) {
  const unit = `rove-budget-${NodeCrypto.randomUUID()}.scope`;
  let cleanupTask: Promise<void> | undefined;
  const stopScope = async () => {
    try {
      await executeProcessControl("systemctl", ["--user", "stop", unit]);
    } catch (cause) {
      // The scope can be collected before our stop reaches the manager.
      const state = await executeProcessControl("systemctl", [
        "--user",
        "show",
        unit,
        "--property=ActiveState",
        "--value",
      ]);
      if (state !== "inactive" && state !== "failed") throw cause;
    }
    if (options?.collect === false) {
      await executeProcessControl("systemctl", ["--user", "reset-failed", unit]).catch(() => {});
    }
  };
  return {
    command: "systemd-run",
    args: [
      "--user",
      "--scope",
      "--quiet",
      ...(options?.collect === false ? [] : ["--collect"]),
      `--slice=${pool}`,
      `--unit=${unit}`,
      "--property=TimeoutStopSec=5s",
      ...deadline,
      ...(options?.properties ?? []).map((property) => `--property=${property}`),
      "--",
      command,
      ...args,
    ],
    unit,
    // A worker can exit while leaving background tool descendants behind.
    // Stop only our named scope, never a process selected by name or path.
    cleanup() {
      return (cleanupTask ??= stopScope());
    },
  };
}
