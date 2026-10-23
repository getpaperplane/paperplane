// @effect-diagnostics nodeBuiltinImport:off -- unit names and RAM size come from the host.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  AgentScope,
  agentScopeCommand,
  type AgentScopeShape,
  type AgentSystemdScope,
} from "@rove-code/shared/AgentScope";
import * as HostProcess from "@rove-code/shared/HostProcess";
import { resolveCommandPath } from "@rove-code/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { roveMemoryBudget } from "./roveMemoryBudget.ts";
import { configureSlice, withSliceLock } from "./systemdSlice.ts";

/**
 * Agents and terminals share this child of app-rove.slice. The parent also
 * contains guarded commands and sits beside the server's own unit in app.slice,
 * keeping the control plane outside their aggregate memory ceiling.
 */
const AGENT_SLICE = "app-rove-agents.slice";

/**
 * The child slice for one server's agents, named after its state directory.
 * Only one server uses a state directory at a time, so an agent in this slice
 * when the server starts was left by an earlier server on the same state,
 * for example one the launcher killed during an update. Other servers on the
 * machine, such as dev servers, have their own slice.
 */
export function ownedAgentSlice(stateDir: string): string {
  const hash = NodeCrypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 12);
  return `app-rove-agents-${hash}.slice`;
}

/** Shared by agents and Pi commands, including hosts that only run Pi. */
export const ensureRoveParentSlice = Effect.fn("ensureRoveParentSlice")(function* (
  ownedSlice?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const environment = yield* HostProcess.Environment;
  const uid = yield* HostProcess.UserId;
  const runtimeDir = environment.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
  const meminfo = yield* fs.readFileString("/proc/meminfo").pipe(Effect.orElseSucceed(() => ""));
  const swap = Number(/^SwapTotal:\s+(\d+)/m.exec(meminfo)?.[1] ?? 0) * 1024;
  const requested = roveMemoryBudget(NodeOS.totalmem(), swap);
  return yield* withSliceLock(
    runtimeDir,
    "app-rove.slice",
    Effect.gen(function* () {
      const limits = yield* configureSlice("app-rove.slice", requested, [
        `MemorySwapMax=${requested.swapMax}`,
        "CPUWeight=100",
        "CPUQuota=",
      ]);
      // Clear limits left by older servers. The parent now owns the aggregate ceiling.
      yield* configureSlice(AGENT_SLICE, { max: Infinity }, ["CPUQuota="]);
      if (ownedSlice !== undefined) {
        yield* configureSlice(ownedSlice, { max: Infinity }, ["CPUQuota="]);
      }
      return { ...limits, swapMax: requested.swapMax };
    }),
  );
});

export interface ScopeState {
  readonly loadState: string;
  readonly activeState: string;
  readonly result: string;
  /** `oom_kill` from the scope's memory.events, while its cgroup exists. */
  readonly oomKills: number;
  /** `populated` from the scope's cgroup.events, while its cgroup exists. */
  readonly populated: boolean | undefined;
}

/**
 * Reads one scope as the server sees it right after the agent process exits.
 * Our pipe can close before systemd handles the kill, so a scope that is
 * still stopping, is empty, or already counted an OOM kill is "stopping":
 * systemd records `Result=oom-kill` for it in a moment.
 */
export function classifyScope(state: ScopeState): "oom-killed" | "gone" | "running" | "stopping" {
  if (state.result === "oom-kill") return "oom-killed";
  if (
    state.loadState !== "loaded" ||
    state.activeState === "inactive" ||
    state.activeState === "failed"
  ) {
    return "gone";
  }
  if (state.activeState === "deactivating" || state.oomKills > 0 || state.populated === false) {
    return "stopping";
  }
  return "running";
}

/** A host-wide counter is only a candidate verdict; the failure label also requires SIGKILL. */
export function classifyUnscopedExit({
  baseline,
  current,
  alive,
}: {
  readonly baseline: number | undefined;
  readonly current: number | undefined;
  readonly alive: boolean | undefined;
}): "likely" | null {
  return alive === false && baseline !== undefined && current !== undefined && current > baseline
    ? "likely"
    : null;
}

function parseKeyValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) values.set(line.slice(0, index), line.slice(index + 1).trim());
  }
  return values;
}

function parseCgroupCounter(text: string, key: string): number | undefined {
  const match = new RegExp(`^${key} (\\d+)$`, "m").exec(text);
  return match === null ? undefined : Number(match[1]);
}

// A stop sends SIGTERM, then SIGKILL after this long. systemd's 90 s default
// would outlast the wait for a previous server's agents below.
const STOP_TIMEOUT_OPTION = "--property=TimeoutStopSec=10s";
const STOPPING_POLL_INTERVAL = "100 millis";
const STOPPING_POLL_ATTEMPTS = 20;
// A stopping scope can wait out its TimeoutStopSec for a stuck process.
const CLEAR_FAILED_INTERVAL = "1 second";
const CLEAR_FAILED_ATTEMPTS = 120;
const MAX_TRACKED_THREADS = 500;

export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform !== "linux") return AgentScope.defaultValue();

  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostEnvironment = yield* HostProcess.Environment;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const ownedSlice = ownedAgentSlice(stateDir);
  const layerScope = yield* Effect.scope;
  const pidDir = path.join(stateDir, "agent-pids");
  // PIDs from an earlier server can have been reused; never trust them.
  yield* fileSystem.remove(pidDir, { recursive: true, force: true }).pipe(Effect.ignore);
  yield* fileSystem.makeDirectory(pidDir, { recursive: true }).pipe(Effect.ignore);
  const unscopedByThread = new Map<
    string,
    { pidfile: string; baseline: number | undefined; verdict: "likely" | null | undefined }
  >();
  const readOomKills = fileSystem.readFileString("/proc/vmstat").pipe(
    Effect.map((text) => parseCgroupCounter(text, "oom_kill")),
    Effect.orElseSucceed(() => undefined),
  );
  const clearUnscoped = (threadId: string) =>
    Effect.gen(function* () {
      const tracked = unscopedByThread.get(threadId);
      unscopedByThread.delete(threadId);
      if (tracked !== undefined) {
        yield* fileSystem.remove(tracked.pidfile, { force: true }).pipe(Effect.ignore);
      }
    });

  const resolve = (command: string, env: NodeJS.ProcessEnv) =>
    resolveCommandPath(command, { env }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
    );

  const run = (command: string, args: ReadonlyArray<string>) =>
    runner.run({ command, args, timeout: "5 seconds" }).pipe(Effect.option);

  const readCgroupFile = (controlGroup: string, file: string) =>
    fileSystem
      .readFileString(path.join("/sys/fs/cgroup", controlGroup, file))
      .pipe(Effect.orElseSucceed(() => ""));

  // Old agents keep their scopes when the server is killed, and the restarted
  // server resumes their sessions. Stop them first, so two copies of one
  // session never work in the same worktree.
  const stopLeftoverAgents = (systemctl: string) =>
    Effect.gen(function* () {
      const shown = yield* run(systemctl, [
        "--user",
        "show",
        ownedSlice,
        "--property=ActiveState,ControlGroup",
      ]);
      if (shown._tag === "None") return;
      const values = parseKeyValues(shown.value.stdout);
      if (values.get("ActiveState") !== "active") return;
      // An active slice can be empty once its last agent exited.
      const controlGroup = values.get("ControlGroup") ?? "";
      const events = controlGroup ? yield* readCgroupFile(controlGroup, "cgroup.events") : "";
      if (parseCgroupCounter(events, "populated") === 0) return;
      yield* Effect.logWarning("Stopping agents left by a previous server", { slice: ownedSlice });
      // Agents get SIGTERM, then SIGKILL after their stop timeout.
      const stopped = yield* runner
        .run({ command: systemctl, args: ["--user", "stop", ownedSlice], timeout: "30 seconds" })
        .pipe(Effect.option);
      if (stopped._tag === "None" || stopped.value.code !== 0) {
        yield* Effect.logWarning("Could not stop agents left by a previous server", {
          slice: ownedSlice,
          stderr: stopped._tag === "Some" ? stopped.value.stderr.trim() : undefined,
        });
      }
    });

  // Runs once, on the first agent or terminal launch. It proves this process
  // can reach a systemd user manager, stops agents a previous server left,
  // creates the agents slice, and sets its limits.
  const systemd = yield* Effect.cached(
    Effect.gen(function* () {
      const runtimeDir = hostEnvironment.XDG_RUNTIME_DIR;
      if (runtimeDir === undefined || runtimeDir.length === 0) return undefined;
      const systemdRun = yield* resolve("systemd-run", hostEnvironment);
      const systemctl = yield* resolve("systemctl", hostEnvironment);
      if (systemdRun === null || systemctl === null) return undefined;
      yield* stopLeftoverAgents(systemctl);
      const probe = (options: ReadonlyArray<string>) =>
        run(systemdRun, [
          "--user",
          "--scope",
          "--quiet",
          "--collect",
          `--slice=${AGENT_SLICE}`,
          ...options,
          "--",
          "true",
        ]).pipe(Effect.map((result) => result._tag === "Some" && result.value.code === 0));
      // Stop the whole scope when the kernel kills one of its processes, and
      // record the result as oom-kill. Scopes take OOMPolicy from systemd 253;
      // older user managers still get scopes, without the OOM label.
      const stopOptions = [STOP_TIMEOUT_OPTION];
      const oomOptions = [...stopOptions, "--property=OOMPolicy=stop"];
      const scopeOptions = (yield* probe(oomOptions))
        ? oomOptions
        : (yield* probe(stopOptions))
          ? stopOptions
          : undefined;
      if (scopeOptions === undefined) {
        yield* Effect.logInfo("Agent scopes are off: no systemd user manager");
        return undefined;
      }
      const limits = yield* ensureRoveParentSlice(ownedSlice).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(HostProcess.Environment, hostEnvironment),
        Effect.catch((cause) =>
          Effect.logWarning("Could not configure Paperplane memory limits", { cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      );
      yield* Effect.logInfo("Agent scopes are on", {
        slice: AGENT_SLICE,
        parent: "app-rove.slice",
        ...limits,
        oomPolicy: scopeOptions.length > 0,
      });
      return {
        systemdRun,
        systemctl,
        runtimeDir,
        scopeOptions,
      };
    }),
  );

  // The newest scope per thread, oldest thread first. A thread runs one agent
  // at a time, so only its latest scope can explain a failure.
  const scopeByThread = new Map<string, { unit: string; oomKilled: boolean }>();

  const readScope = (systemctl: string, unit: string) =>
    Effect.gen(function* () {
      const shown = yield* run(systemctl, [
        "--user",
        "show",
        unit,
        "--property=LoadState,ActiveState,Result,ControlGroup",
      ]);
      // A failed query says nothing about the scope; the caller keeps the unit.
      if (shown._tag === "None" || shown.value.code !== 0) return undefined;
      const values = parseKeyValues(shown.value.stdout);
      const controlGroup = values.get("ControlGroup") ?? "";
      const memoryEvents = controlGroup ? yield* readCgroupFile(controlGroup, "memory.events") : "";
      const cgroupEvents = controlGroup ? yield* readCgroupFile(controlGroup, "cgroup.events") : "";
      const populated = parseCgroupCounter(cgroupEvents, "populated");
      return {
        loadState: values.get("LoadState") ?? "",
        activeState: values.get("ActiveState") ?? "",
        result: values.get("Result") ?? "",
        oomKills: parseCgroupCounter(memoryEvents, "oom_kill") ?? 0,
        populated: populated === undefined ? undefined : populated === 1,
      } satisfies ScopeState;
    });

  const clearFailed = (systemctl: string, unit: string) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < CLEAR_FAILED_ATTEMPTS; attempt++) {
        const state = yield* readScope(systemctl, unit);
        if (state === undefined) return;
        if (state.activeState === "failed") {
          yield* run(systemctl, ["--user", "reset-failed", unit]);
          return;
        }
        if (state.activeState !== "deactivating") return;
        yield* Effect.sleep(CLEAR_FAILED_INTERVAL);
      }
    });

  // Failed scopes stay loaded so we can read their result. Clear them once
  // systemd finishes stopping them.
  const forget = (systemctl: string, unit: string) =>
    clearFailed(systemctl, unit).pipe(Effect.forkIn(layerScope), Effect.asVoid);

  // Drops the oldest thread's scope once it has ended. A scope that still
  // runs moves to the back, so its thread keeps its OOM answer and cleanup.
  const evictOldest = (systemctl: string) =>
    Effect.gen(function* () {
      const oldest = scopeByThread.entries().next();
      if (oldest.done === true) return;
      const [threadId, tracked] = oldest.value;
      const state = yield* readScope(systemctl, tracked.unit);
      // A newer launch replaced it while we read, and forgets it itself.
      if (scopeByThread.get(threadId) !== tracked) return;
      scopeByThread.delete(threadId);
      const status = state === undefined ? "running" : classifyScope(state);
      if (status === "running" || status === "stopping") {
        scopeByThread.set(threadId, tracked);
        return;
      }
      yield* forget(systemctl, tracked.unit);
    });

  // Records a thread's newest scope, or forgets the thread when `unit` is
  // undefined. The replaced scope has its failed state cleared.
  const track = (systemctl: string, threadId: string, unit: string | undefined) =>
    Effect.gen(function* () {
      const previous = scopeByThread.get(threadId);
      scopeByThread.delete(threadId);
      if (unit !== undefined) scopeByThread.set(threadId, { unit, oomKilled: false });
      if (previous !== undefined) yield* forget(systemctl, previous.unit);
      if (scopeByThread.size > MAX_TRACKED_THREADS) yield* evictOldest(systemctl);
    });

  const oomKill: AgentScopeShape["oomKill"] = (threadId) =>
    Effect.gen(function* () {
      const unscoped = unscopedByThread.get(threadId);
      if (unscoped !== undefined) {
        if (unscoped.verdict !== undefined) return unscoped.verdict;
        const pid = yield* fileSystem.readFileString(unscoped.pidfile).pipe(
          Effect.map((text) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined)),
          Effect.orElseSucceed(() => undefined),
        );
        if (pid === undefined || pid <= 0) return null;
        const alive = yield* fileSystem.readFileString(`/proc/${pid}/stat`).pipe(
          // The comm field can contain spaces and parentheses. State follows its last ')'.
          Effect.map((text) => {
            const state = /^\s+([A-Z])\s/.exec(text.slice(text.lastIndexOf(")") + 1))?.[1];
            return state === undefined ? undefined : state !== "Z" && state !== "X";
          }),
          Effect.catch((error) =>
            Effect.succeed(error.reason._tag === "NotFound" ? false : undefined),
          ),
        );
        const verdict = classifyUnscopedExit({
          baseline: unscoped.baseline,
          current: yield* readOomKills,
          alive,
        });
        // Once exit is known, a later host OOM must not relabel this old launch.
        if (alive === false && unscopedByThread.get(threadId) === unscoped)
          unscoped.verdict = verdict;
        return verdict;
      }
      const tracked = scopeByThread.get(threadId);
      if (tracked === undefined) return null;
      if (tracked.oomKilled) return "confirmed";
      const scope = yield* systemd;
      if (scope === undefined) return null;
      for (let attempt = 0; attempt < STOPPING_POLL_ATTEMPTS; attempt++) {
        const state = yield* readScope(scope.systemctl, tracked.unit);
        if (state === undefined) return null;
        const status = classifyScope(state);
        if (status === "running") return null;
        if (status === "stopping") {
          yield* Effect.sleep(STOPPING_POLL_INTERVAL);
          continue;
        }
        yield* forget(scope.systemctl, tracked.unit);
        if (status === "gone") return null;
        yield* Effect.logWarning("Agent scope was killed: out of memory", {
          threadId,
          unit: tracked.unit,
        });
        tracked.oomKilled = true;
        return "confirmed";
      }
      return null;
    });

  const clear: AgentScopeShape["clear"] = (threadId) =>
    Effect.gen(function* () {
      yield* clearUnscoped(threadId);
      if (!scopeByThread.has(threadId)) return;
      const scope = yield* systemd;
      if (scope !== undefined) yield* track(scope.systemctl, threadId, undefined);
    });

  return {
    wrap: Effect.fn("AgentScope.wrap")(function* ({
      command,
      args,
      name,
      threadId,
      env,
      survivesRestart,
    }) {
      if (threadId !== undefined) yield* clearUnscoped(threadId);
      const resolved = yield* resolve(command, env ?? hostEnvironment);
      // Leave unresolved commands alone so the spawn reports the missing binary.
      if (resolved === null) return { command, args };
      const scope = yield* systemd;
      if (scope === undefined) {
        if (threadId === undefined) return agentScopeCommand({ command: resolved, args });
        const pidfile = path.join(pidDir, `${NodeCrypto.randomUUID()}.pid`);
        const baseline = yield* readOomKills;
        unscopedByThread.set(threadId, { pidfile, baseline, verdict: undefined });
        if (unscopedByThread.size > MAX_TRACKED_THREADS) {
          const oldest = unscopedByThread.keys().next();
          if (!oldest.done) yield* clearUnscoped(oldest.value);
        }
        return agentScopeCommand({ command: resolved, args, pidfile });
      }
      const unit = `rove-${name}-${NodeCrypto.randomUUID().slice(0, 8)}.scope`;
      if (threadId !== undefined) yield* track(scope.systemctl, threadId, unit);
      const systemdScope: AgentSystemdScope = {
        systemdRun: scope.systemdRun,
        runtimeDir: scope.runtimeDir,
        slice: survivesRestart === true ? AGENT_SLICE : ownedSlice,
        unit,
        // Without a thread nothing reads the result, so let systemd unload
        // the unit even when it fails.
        options: threadId === undefined ? [...scope.scopeOptions, "--collect"] : scope.scopeOptions,
      };
      return agentScopeCommand({ command: resolved, args, scope: systemdScope });
    }),
    oomKill,
    clear,
  } satisfies AgentScopeShape;
});

export const layer = Layer.effect(AgentScope, make).pipe(Layer.provide(ProcessRunner.layer));
