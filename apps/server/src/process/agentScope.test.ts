// @effect-diagnostics nodeBuiltinImport:off -- fake systemd binaries live in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@getpaperplane/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  classifyScope,
  classifyUnscopedExit,
  make,
  ownedAgentSlice,
  type ScopeState,
} from "./agentScope.ts";

import { vi } from "vite-plus/test";
vi.mock("./systemdSlice.ts", async (original) => ({
  ...(await original<typeof import("./systemdSlice.ts")>()),
  // The fake manager needs no cross-process lease; exercise real locking separately.
  withSliceLock: (_runtime: string, _unit: string, body: Effect.Effect<unknown>) => body,
}));

const running: ScopeState = {
  loadState: "loaded",
  activeState: "active",
  result: "success",
  oomKills: 0,
  populated: true,
};

describe("classifyUnscopedExit", () => {
  it("requires both a dead agent and an increased, readable host counter", () => {
    expect(classifyUnscopedExit({ baseline: 3, current: 4, alive: false })).toBe("likely");
    for (const alive of [true, undefined]) {
      expect(classifyUnscopedExit({ baseline: 3, current: 4, alive })).toBeNull();
    }
    expect(classifyUnscopedExit({ baseline: 3, current: 3, alive: false })).toBeNull();
    expect(classifyUnscopedExit({ baseline: 3, current: 2, alive: false })).toBeNull();
    expect(classifyUnscopedExit({ baseline: undefined, current: 4, alive: false })).toBeNull();
    expect(classifyUnscopedExit({ baseline: 3, current: undefined, alive: false })).toBeNull();
  });
});

describe("classifyScope", () => {
  it("reports an OOM kill only once systemd records it", () => {
    expect(classifyScope({ ...running, activeState: "failed", result: "oom-kill" })).toBe(
      "oom-killed",
    );
    // The agent pipe can close before systemd handles the kill.
    expect(classifyScope({ ...running, oomKills: 1 })).toBe("stopping");
    expect(classifyScope({ ...running, populated: false })).toBe("stopping");
    expect(classifyScope({ ...running, activeState: "deactivating" })).toBe("stopping");
  });

  it("does not wait on a live agent or a scope that ended for another reason", () => {
    expect(classifyScope(running)).toBe("running");
    expect(classifyScope({ ...running, activeState: "inactive", populated: undefined })).toBe(
      "gone",
    );
    expect(classifyScope({ ...running, loadState: "not-found", activeState: "inactive" })).toBe(
      "gone",
    );
  });
});

// Runs the real service against a fake user manager. `units` holds the
// ActiveState and Result that `systemctl show` reports for each scope or
// slice, and `calls` records every command in order.
const withFakeSystemd = <A, E>(
  body: (input: {
    readonly scope: Effect.Success<typeof make>;
    readonly units: Map<string, { activeState: string; result: string }>;
    readonly calls: ReadonlyArray<ReadonlyArray<string>>;
    readonly stateDir: string;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "paperplane-agent-scope-"));
    for (const name of ["systemd-run", "systemctl", "agent"]) {
      NodeFS.writeFileSync(NodePath.join(bin, name), "", { mode: 0o755 });
    }
    const units = new Map<string, { activeState: string; result: string }>();
    const calls: Array<ReadonlyArray<string>> = [];
    const output = (stdout: string): ProcessRunner.ProcessRunOutput => ({
      stdout,
      stderr: "",
      code: ChildProcessSpawner.ExitCode(0),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    });
    const runner = ProcessRunner.ProcessRunner.of({
      run: ({ args }) =>
        Effect.sync(() => {
          calls.push(args);
          const [, verb, unit = ""] = args;
          if (verb === "reset-failed") units.delete(unit);
          if (verb !== "show") return output("");
          const state = units.get(unit);
          return output(
            state === undefined
              ? "LoadState=not-found\nActiveState=inactive\nResult=success\n"
              : `LoadState=loaded\nActiveState=${state.activeState}\nResult=${state.result}\n`,
          );
        }),
    });
    const scope = yield* make.pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: bin, XDG_RUNTIME_DIR: "/run/user/1" }),
    );
    const { stateDir } = yield* ServerConfig.ServerConfig;
    return yield* body({ scope, units, calls, stateDir }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(bin, { recursive: true, force: true }))),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "paperplane-agent-scope-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const unitOf = (launch: { readonly args: ReadonlyArray<string> }) =>
  launch.args.find((arg) => arg.startsWith("--unit="))?.slice("--unit=".length) ?? "";

const sliceOf = (launch: { readonly args: ReadonlyArray<string> }) =>
  launch.args.find((arg) => arg.startsWith("--slice="))?.slice("--slice=".length) ?? "";

describe("AgentScope without systemd", () => {
  it.effect("tracks pidfiles and vmstat, caches likely, and removes stale launch evidence", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const pidDir = NodePath.join(stateDir, "agent-pids");
      const files = new Map<string, string>([[`${pidDir}/stale.pid`, "10"]]);
      const removed: string[] = [];
      const missing = (path: string) =>
        PlatformError.systemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "readFileString",
          pathOrDescriptor: path,
        });
      const fakeFs = FileSystem.makeNoop({
        ...fs,
        readFileString: (path) =>
          Effect.suspend(() => {
            if (!path.startsWith("/proc/") && !path.startsWith(pidDir))
              return fs.readFileString(path);
            const text = files.get(path);
            return text === undefined ? Effect.fail(missing(path)) : Effect.succeed(text);
          }),
        makeDirectory: () => Effect.void,
        remove: (path) =>
          Effect.sync(() => {
            removed.push(path);
            for (const key of files.keys())
              if (key === path || key.startsWith(`${path}/`)) files.delete(key);
          }),
      });
      const scope = yield* make.pipe(
        Effect.provideService(FileSystem.FileSystem, fakeFs),
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({
            run: () => Effect.die("No systemd command should run"),
          }),
        ),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, {}),
      );
      expect(removed).toEqual([pidDir]);
      expect(files.has(`${pidDir}/stale.pid`)).toBe(false);
      files.set("/proc/vmstat", "oom_kill 7\n");
      const launch = yield* scope.wrap({
        command: "/bin/sh",
        args: ["-c", "true"],
        name: "test",
        threadId: "a",
      });
      const pidfile = launch.args.find((arg) => arg.startsWith(pidDir))!;
      expect(pidfile).toMatch(/agent-pids\/[\w-]+\.pid$/);
      expect(launch.args[1]).toContain('echo $$ >"$1"');
      expect(launch.args[1]).toContain('exec "$@"');
      files.set("/proc/vmstat", "oom_kill 8\n");
      // A launch whose script has not run is not evidence of a dead agent.
      expect(yield* scope.oomKill("a")).toBeNull();
      files.set(pidfile, "123\n");
      files.set("/proc/123/stat", "123 (agent (worker)) S 1 2");
      expect(yield* scope.oomKill("a")).toBeNull();
      files.set("/proc/123/stat", "123 (agent (worker)) Z 1 2");
      expect(yield* scope.oomKill("a")).toBe("likely");
      files.set("/proc/vmstat", "oom_kill 0\n");
      expect(yield* scope.oomKill("a")).toBe("likely");
      yield* scope.wrap({ command: "/bin/sh", args: [], name: "test", threadId: "a" });
      expect(files.has(pidfile)).toBe(false);
      expect(yield* scope.oomKill("a")).toBeNull();
      const newestPidfile = `${pidDir}/`;
      yield* scope.clear("a");
      expect(removed.filter((path) => path.startsWith(newestPidfile))).toHaveLength(2);
      expect(yield* scope.oomKill("a")).toBeNull();

      // A missing proc entry also proves exit, but only after the counter rises.
      files.set("/proc/vmstat", "oom_kill 20\n");
      const gone = yield* scope.wrap({
        command: "/bin/sh",
        args: [],
        name: "test",
        threadId: "gone",
      });
      files.set(
        gone.args.find((arg) => arg.startsWith(pidDir))!,
        "456\n",
      );
      expect(yield* scope.oomKill("gone")).toBeNull();
      files.set("/proc/vmstat", "oom_kill 21\n");
      // A known-dead launch keeps its null verdict despite an unrelated later OOM.
      expect(yield* scope.oomKill("gone")).toBeNull();
      const replacement = yield* scope.wrap({
        command: "/bin/sh",
        args: [],
        name: "test",
        threadId: "gone",
      });
      files.set(
        replacement.args.find((arg) => arg.startsWith(pidDir))!,
        "789\n",
      );
      files.set("/proc/vmstat", "oom_kill 22\n");
      expect(yield* scope.oomKill("gone")).toBe("likely");
      const oldestPidfile = replacement.args.find((arg) => arg.startsWith(pidDir))!;
      for (let index = 0; index < 500; index++) {
        const next = yield* scope.wrap({
          command: "/bin/sh",
          args: [],
          name: "test",
          threadId: `bounded-${index}`,
        });
        files.set(
          next.args.find((arg) => arg.startsWith(pidDir))!,
          "999\n",
        );
      }
      expect(files.has(oldestPidfile)).toBe(false);
      expect(yield* scope.oomKill("gone")).toBeNull();
      expect([...files.keys()].filter((key) => key.startsWith(pidDir))).toHaveLength(500);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "paperplane-unscoped-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});

describe("AgentScope service", () => {
  it.effect("labels a thread from its newest scope until its next session clears it", () =>
    withFakeSystemd(({ scope, units }) =>
      Effect.gen(function* () {
        const first = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        units.set(unitOf(first), { activeState: "failed", result: "oom-kill" });
        const second = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        units.set(unitOf(second), { activeState: "active", result: "success" });
        // The older scope was OOM-killed, but the newest one is still running.
        expect(yield* scope.oomKill("a")).toBe(null);

        units.set(unitOf(second), { activeState: "failed", result: "oom-kill" });
        expect(yield* scope.oomKill("a")).toBe("confirmed");
        // A retried failure reads the same, even after the failed unit is reset.
        units.delete(unitOf(second));
        expect(yield* scope.oomKill("a")).toBe("confirmed");

        // The next session may run without a scope, for example on Cursor.
        yield* scope.clear("a");
        expect(yield* scope.oomKill("a")).toBe(null);
      }),
    ),
  );

  it.effect("keeps a running scope while hundreds of other threads launch", () =>
    withFakeSystemd(({ scope, units }) =>
      Effect.gen(function* () {
        const live = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "live" });
        units.set(unitOf(live), { activeState: "active", result: "success" });
        for (let index = 0; index < 600; index++) {
          yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: `other-${index}` });
        }
        units.set(unitOf(live), { activeState: "failed", result: "oom-kill" });
        expect(yield* scope.oomKill("live")).toBe("confirmed");
      }),
    ),
  );

  it.effect("stops agents a killed server left before the first launch", () =>
    withFakeSystemd(({ scope, units, calls, stateDir }) =>
      Effect.gen(function* () {
        units.set(ownedAgentSlice(stateDir), { activeState: "active", result: "success" });
        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const stops = calls.filter(([, verb]) => verb === "stop");
        expect(stops).toEqual([["--user", "stop", ownedAgentSlice(stateDir)]]);
        // Agents run in this server's own slice; terminals stay outside it.
        expect(sliceOf(agent)).toBe(ownedAgentSlice(stateDir));
        // An agent that ignores SIGTERM is killed well inside the stop's wait.
        expect(agent.args).toContain("--property=TimeoutStopSec=10s");
        const terminal = yield* scope.wrap({
          command: "agent",
          args: [],
          name: "terminal",
          survivesRestart: true,
        });
        expect(sliceOf(terminal)).toBe("app-paperplane-agents.slice");
        // Only the first launch looks for leftovers.
        expect(calls.filter(([, verb]) => verb === "stop")).toHaveLength(1);
      }),
    ),
  );

  it.effect("moves agent limits to the common parent and resets both child slices", () =>
    withFakeSystemd(({ scope, calls, stateDir }) =>
      Effect.gen(function* () {
        yield* scope.wrap({ command: "agent", args: [], name: "t" });
        const properties = calls.filter(([, verb]) => verb === "set-property");
        expect(
          properties.some(
            (args) =>
              args.includes("app-paperplane.slice") &&
              args.includes("CPUWeight=100") &&
              args.includes("MemoryHigh=infinity") &&
              args.includes("CPUQuota="),
          ),
        ).toBe(true);
        for (const unit of ["app-paperplane-agents.slice", ownedAgentSlice(stateDir)]) {
          expect(
            properties.some(
              (args) =>
                args.includes(unit) &&
                args.includes("MemoryHigh=infinity") &&
                args.includes("MemoryMax=infinity"),
            ),
          ).toBe(true);
        }
      }),
    ),
  );

  it.effect("leaves a quiet slice alone", () =>
    withFakeSystemd(({ scope, calls }) =>
      Effect.gen(function* () {
        yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        expect(calls.filter(([, verb]) => verb === "stop")).toEqual([]);
      }),
    ),
  );
});
