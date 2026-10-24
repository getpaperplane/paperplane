import type {
  HostHealthFinding,
  HostHealthReport,
  PaperplaneMemoryUsage,
} from "@getpaperplane/contracts";
import * as HostProcess from "@getpaperplane/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { isUnderMemoryPressure } from "../orchestration-v2/providerSessionPressure.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";

const GIB = 1024 ** 3;
const QUANTUM = 64 * 1024 ** 2;
const roundBytes = (bytes: number) => Math.round(bytes / QUANTUM) * QUANTUM;

interface HealthFacts {
  readonly totalMemoryBytes: number;
  readonly availableMemoryBytes: number;
  readonly swapTotalBytes: number | null;
  readonly wsl: boolean;
  readonly userManager: boolean;
  readonly paperplaneMemory: PaperplaneMemoryUsage | null;
  readonly hostOomKills: number;
  readonly stalls: ReadonlyArray<{ readonly time: number; readonly delayMaxMs: number }>;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
export function hostHealthFindings(
  facts: HealthFacts,
  { now, oomBaseline }: { readonly now: number; readonly oomBaseline: number },
): ReadonlyArray<HostHealthFinding> {
  const findings: HostHealthFinding[] = [];
  if (facts.wsl && !facts.userManager) {
    findings.push({
      id: "wsl_without_systemd",
      severity: "warning",
      message:
        "WSL is running without a systemd user manager; Paperplane's memory ceiling is unavailable.",
      fix: "Under `[boot]` in /etc/wsl.conf set `systemd=true`, run `wsl --shutdown` in Windows, then run `loginctl enable-linger $USER` in WSL.",
    });
  }
  if (isUnderMemoryPressure(facts)) {
    findings.push({
      id: "memory_pressure",
      severity: "warning",
      message: "The host has little available memory.",
      fix: facts.wsl
        ? "Run fewer agents at once or raise memory= under [wsl2] in .wslconfig."
        : "Run fewer agents at once or add memory.",
    });
  }
  if (facts.swapTotalBytes === 0 && facts.totalMemoryBytes <= 8 * GIB) {
    findings.push({
      id: "no_swap",
      severity: "warning",
      message: "This small host has no swap.",
      fix: facts.wsl ? "Add `swap=4GB` under [wsl2] in .wslconfig." : "Add a swap file.",
    });
  }
  const recent = facts.stalls.filter(
    (stall) =>
      stall.time >= now - 24 * 60 * 60 * 1000 && stall.time <= now && stall.delayMaxMs >= 1000,
  );
  if (recent.length > 0) {
    const worst = Math.max(...recent.map((stall) => stall.delayMaxMs)) / 1000;
    findings.push({
      id: "event_loop_stalls",
      severity: "warning",
      message: `${plural(recent.length, "event-loop stall")}, worst ${worst.toFixed(1)} s in the last 24 hours.`,
      fix: "Run fewer agents at once and check the host's memory and CPU load.",
    });
  }
  if (facts.paperplaneMemory !== null && facts.paperplaneMemory.oomKills > oomBaseline) {
    findings.push({
      id: "rove_oom_kills",
      severity: "warning",
      message: `${plural(facts.paperplaneMemory.oomKills - oomBaseline, "out-of-memory kill")} under the Paperplane memory ceiling since the server started.`,
      fix: "Run fewer agents at once or raise the Paperplane memory ceiling.",
    });
  } else if (facts.paperplaneMemory === null && facts.hostOomKills > 0) {
    findings.push({
      id: "host_oom_kills",
      severity: "info",
      message: `${plural(facts.hostOomKills, "host out-of-memory kill")} since boot.`,
      fix: "Run fewer agents at once or add swap.",
    });
  }
  return findings;
}

export class HostHealth extends Context.Service<
  HostHealth,
  {
    readonly read: Effect.Effect<HostHealthReport>;
    readonly changes: Stream.Stream<HostHealthReport>;
  }
>()("@getpaperplane/server/diagnostics/HostHealth") {}

function counter(text: string, key: string): number {
  return Number(new RegExp(`^${key}\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0);
}

function parseStalls(text: string): HealthFacts["stalls"] {
  return text.split("\n").flatMap((line) => {
    try {
      const entry: unknown = JSON.parse(line);
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("time" in entry) ||
        !("delayMaxMs" in entry) ||
        typeof entry.time !== "string" ||
        typeof entry.delayMaxMs !== "number"
      )
        return [];
      const time = Date.parse(entry.time);
      return Number.isFinite(time) && Number.isFinite(entry.delayMaxMs)
        ? [{ time, delayMaxMs: entry.delayMaxMs }]
        : [];
    } catch {
      return [];
    }
  });
}

const make = Effect.fnUntraced(function* (options: { readonly oomBaseline?: number } = {}) {
  const fs = yield* FileSystem.FileSystem;
  const resources = yield* HostResources.HostResources;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const uid = yield* HostProcess.UserId;
  const config = yield* ServerConfig.ServerConfig;
  const readText = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
  const exists = (path: string) => fs.exists(path).pipe(Effect.orElseSucceed(() => false));
  const resolveCgroup = Effect.gen(function* () {
    if (platform !== "linux" || uid === undefined) return undefined;
    const conventional = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/app-rove.slice`;
    // The slice may be created by the first agent after this service starts.
    let cgroup = conventional;
    if (!(yield* exists(`${conventional}/memory.current`))) {
      const self = yield* readText("/proc/self/cgroup");
      const ownPath = /^0::([^\n]+)$/m.exec(self)?.[1];
      const slicePath = ownPath?.match(/^(.*\/app-rove\.slice)(?:\/|$)/)?.[1];
      const managerPath = ownPath?.match(/^(.*\/user@\d+\.service)(?:\/|$)/)?.[1];
      const candidate =
        slicePath ?? (managerPath ? `${managerPath}/app.slice/app-rove.slice` : undefined);
      if (candidate && !candidate.split("/").includes("..")) cgroup = `/sys/fs/cgroup${candidate}`;
    }
    return cgroup;
  });
  let cgroup = yield* resolveCgroup;
  let hasRoveMemory = false;
  const baseline =
    options.oomBaseline ??
    (cgroup ? counter(yield* readText(`${cgroup}/memory.events`), "oom_kill") : 0);
  let stallMtime: number | undefined | null = null;
  let stalls: HealthFacts["stalls"] = [];
  const sample = Effect.gen(function* () {
    const memory = yield* resources.readMemory;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    let swapTotalBytes: number | null = null;
    let swapFreeBytes: number | null = null;
    let paperplaneMemory: PaperplaneMemoryUsage | null = null;
    let wsl = false;
    let userManager = false;
    let hostOomKills = 0;
    if (platform === "linux") {
      const meminfo = yield* readText("/proc/meminfo");
      swapTotalBytes = counter(meminfo, "SwapTotal:") * 1024;
      swapFreeBytes = counter(meminfo, "SwapFree:") * 1024;
      wsl =
        /microsoft/i.test(yield* readText("/proc/sys/kernel/osrelease")) ||
        environment.WSL_INTEROP !== undefined;
      userManager = uid !== undefined && (yield* exists(`/run/user/${uid}/systemd/private`));
      hostOomKills = counter(yield* readText("/proc/vmstat"), "oom_kill");
      if (!hasRoveMemory) cgroup = yield* resolveCgroup;
      if (cgroup) {
        const limit = yield* readText(`${cgroup}/memory.max`);
        const current = yield* readText(`${cgroup}/memory.current`);
        const swapLimit = yield* readText(`${cgroup}/memory.swap.max`);
        const swapCurrent = yield* readText(`${cgroup}/memory.swap.current`);
        const finiteBytes = (text: string) =>
          /^\d+$/.test(text.trim()) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
        const currentBytes = finiteBytes(current);
        if (currentBytes !== null)
          paperplaneMemory = {
            limitBytes: finiteBytes(limit),
            currentBytes,
            swapLimitBytes: finiteBytes(swapLimit),
            swapCurrentBytes: finiteBytes(swapCurrent),
            oomKills: counter(yield* readText(`${cgroup}/memory.events`), "oom_kill"),
          };
      }
      hasRoveMemory = paperplaneMemory !== null;
    }
    const stallPath = `${config.logsDir}/event-loop-stalls.ndjson`;
    const stat = yield* fs.stat(stallPath).pipe(Effect.option);
    const mtime = Option.isSome(stat)
      ? Option.getOrUndefined(stat.value.mtime)?.getTime()
      : undefined;
    if (mtime !== stallMtime) {
      stalls = parseStalls(yield* readText(stallPath));
      stallMtime = mtime;
    }
    const findings = hostHealthFindings(
      { ...memory, swapTotalBytes, paperplaneMemory, wsl, userManager, hostOomKills, stalls },
      { now, oomBaseline: baseline },
    );
    return {
      sampledAt: now,
      totalMemoryBytes: memory.totalMemoryBytes,
      availableMemoryBytes: memory.availableMemoryBytes,
      swapTotalBytes,
      swapFreeBytes,
      memoryPressure: isUnderMemoryPressure(memory),
      paperplaneMemory,
      findings,
    } satisfies HostHealthReport;
  });
  const cache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "health") => sample,
    timeToLive: "10 seconds",
  });
  const read = Cache.get(cache, "health");
  return HostHealth.of({
    read,
    changes: Stream.fromEffectSchedule(read, Schedule.spaced("30 seconds")).pipe(
      Stream.changesWith((a, b) => {
        // Suppress small fluctuations only for subscriptions; doctor/MCP read exact bytes.
        const key = (report: HostHealthReport) =>
          JSON.stringify({ ...report, sampledAt: 0 }, (name, value: unknown) =>
            name.endsWith("Bytes") && typeof value === "number" ? roundBytes(value) : value,
          );
        return key(a) === key(b);
      }),
    ),
  });
});

export const layer = Layer.effect(HostHealth, make());
/** Doctor reports all cgroup OOM kills, rather than only those since server startup. */
export const layerForDoctor = Layer.effect(HostHealth, make({ oomBaseline: 0 }));
