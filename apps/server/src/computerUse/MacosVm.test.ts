import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  type ServerSettings as Settings,
} from "@getpaperplane/contracts";
import {
  Environment as HostProcessEnvironment,
  Platform as HostProcessPlatform,
} from "@getpaperplane/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type * as Scope from "effect/Scope";
import type * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CuaDriver from "./CuaDriver.ts";
import * as MacosVm from "./MacosVm.ts";
import * as ComputerDesktops from "./ComputerDesktops.ts";

const { transports } = vi.hoisted(() => ({
  transports: [] as Array<{ command: string; args: string[] }>,
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    constructor(input: { command: string; args: string[] }) {
      transports.push(input);
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect() {}
    async close() {}
    getInstructions() {
      return "Guest driver.";
    }
    async listTools() {
      return { tools: [{ name: "click", inputSchema: { type: "object" } }] };
    }
    async callTool() {
      return { content: [{ type: "text", text: "guest" }] };
    }
  },
}));
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const output = (stdout = "", code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
interface Vm {
  name: string;
  status: string;
  ipAddress: string | null;
  vncUrl?: string | null;
  diskSize: { allocated: number; total: number };
  memorySize: number;
}
const golden = "rove-cua-golden";
const work = "rove-cua-work-1";
const record = (name: string): Vm => ({
  name,
  status: "stopped",
  ipAddress: null,
  diskSize: { allocated: 42_000, total: 150_000_000_000 },
  memorySize: 8_589_934_592,
});

const harness = <A, E>(
  body: (h: {
    runtime: MacosVm.MacosVm["Service"];
    registry: ComputerDesktops.ComputerDesktops["Service"];
    makeRuntime: (
      arch?: string,
    ) => Effect.Effect<
      MacosVm.MacosVm["Service"],
      never,
      Scope.Scope | FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig
    >;
    makeDriver: () => Effect.Effect<
      CuaDriver.CuaDriver["Service"],
      never,
      Scope.Scope | FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig
    >;
    vms: Map<string, Vm>;
    runs: Array<ProcessRunner.ProcessRunInput>;
    stateDir: string;
    setConsent: (value: unknown) => void;
    setIp: (value: string | null) => void;
    setSetupExitCode: (value: number) => void;
    setBootFailure: (value: boolean) => void;
    setMalformedOutput: (command: "ls" | "get" | null) => void;
    /** Free space `df` reports in KiB, or null to make `df` fail. */
    setFreeKib: (kib: number | null) => void;
    waitForPreparation: Effect.Effect<void>;
    setPull: (effect: (input: ProcessRunner.ProcessRunInput) => Effect.Effect<void>) => void;
    setSetup: (effect: Effect.Effect<void>) => void;
    waitForBoot: Effect.Effect<void>;
    processes: Map<number, string>;
    change: (patch: Partial<Settings>) => Effect.Effect<void>;
  }) => Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const stateDir = config.stateDir;
    const bin = `${stateDir}/bin/lume`;
    yield* fs.makeDirectory(`${stateDir}/bin`, { recursive: true });
    yield* fs.writeFileString(bin, "fake");
    const vms = new Map<string, Vm>();
    const setupFiber = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
    let pull: (input: ProcessRunner.ProcessRunInput) => Effect.Effect<void> = () => Effect.void;
    let setup: Effect.Effect<void> = Effect.void;
    const bootRequested = yield* Deferred.make<void>();
    const runs: Array<ProcessRunner.ProcessRunInput> = [];
    const processes = new Map([[process.pid, "today\n"]]);
    let ip: string | null = "192.168.64.2";
    let setupExitCode = 0;
    let bootFailure = false;
    let malformedOutput: "ls" | "get" | null = null;
    let freeKib: number | null = 800_000_000;
    let consent: unknown = {
      accessibility: true,
      screen_recording: true,
      source: { attribution: "driver-daemon" },
    };
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) => {
        if (bootFailure && input.args[0] === "run") {
          runs.push(input);
          return Effect.fail(
            new ProcessRunner.ProcessSpawnError({
              command: input.command,
              argumentCount: input.args.length,
              cause: new Error(input.args.join(" ")),
            }),
          );
        }
        return Effect.gen(function* () {
          runs.push(input);
          const args = input.args;
          if (input.command === "/bin/ps")
            return output(
              processes.get(Number(args[1])) ?? "",
              processes.has(Number(args[1])) ? 0 : 1,
            );
          if (input.command === "/bin/df")
            return freeKib === null
              ? output("", 1)
              : output(
                  `Filesystem 1024-blocks Used Available Capacity Mounted on\ndisk 900000000 100000000 ${freeKib} 10% /\n`,
                );
          if (input.command === "/usr/bin/ssh-keygen") {
            const key = args[args.indexOf("-f") + 1];
            yield* fs.writeFileString(key!, "private");
            yield* fs.writeFileString(`${key}.pub`, "ssh-ed25519 AAAATEST paperplane-cua\n");
            return output();
          }
          if (input.command === "/bin/bash") {
            yield* fs.writeFileString(bin, "fake installed lume");
            return output();
          }
          if (input.command === "/usr/bin/ssh") return output(json(consent));
          if (!input.command.endsWith("/lume"))
            throw new Error(`Unexpected command ${input.command}`);
          if (args[0] === malformedOutput)
            return output(
              json([{ name: golden, status: 42, vncUrl: "vnc://:decode-secret@127.0.0.1:5900" }]),
            );
          switch (args[0]) {
            case "--version":
              return output("lume 0.6.1\n");
            case "ls":
              return output(json([...vms.values()]));
            case "ssh":
              yield* Deferred.succeed(setupFiber, yield* Effect.fiber);
              yield* setup;
              return output("", setupExitCode);
            case "get":
              if (args[1] === work && ip === null)
                yield* Deferred.succeed(bootRequested, undefined);
              return output(json(vms.has(args[1]!) ? [vms.get(args[1]!)] : []));
            case "pull":
              yield* pull(input);
              vms.set(args[2]!, record(args[2]!));
              return output();
            case "clone":
              vms.set(args[2]!, record(args[2]!));
              return output();
            case "run": {
              const vm = vms.get(args[1]!)!;
              vm.status = "running";
              vm.ipAddress = ip;
              vm.vncUrl = `vnc://:${args[args.indexOf("--vnc-password") + 1]}@127.0.0.1:5900`;
              return output();
            }
            case "stop": {
              const vm = vms.get(args[1]!)!;
              vm.status = "stopped";
              vm.ipAddress = null;
              return output();
            }
            case "delete":
              vms.delete(args[1]!);
              return output();
            default:
              throw new Error(`Unexpected Lume command ${args.join(" ")}`);
          }
        }).pipe(Effect.orDie);
      },
    });
    let settings: Settings = {
      ...DEFAULT_SERVER_SETTINGS,
      enableAgentComputerUse: true,
      computerUseMacosMode: "isolated-vm",
    };
    const events = yield* Queue.unbounded<{ value: Settings; drained: Deferred.Deferred<void> }>();
    const changes = Stream.fromQueue(events).pipe(
      Stream.flatMap(({ value, drained }) =>
        Stream.make(value).pipe(
          Stream.concat(Stream.fromEffect(Deferred.succeed(drained, undefined)).pipe(Stream.drain)),
        ),
      ),
    );
    const settingsLayer = Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.sync(() => settings),
      subscribeChanges: Effect.succeed(changes),
    });
    const registry = yield* ComputerDesktops.make;
    yield* registry.setMode("isolated");
    const provide = <A2, E2, R>(effect: Effect.Effect<A2, E2, R>) =>
      effect.pipe(
        Effect.provideService(ComputerDesktops.ComputerDesktops, registry),
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provideService(HostProcessEnvironment, { HOME: stateDir, PATH: `${stateDir}/bin` }),
        Effect.provideService(HostProcessPlatform, "darwin"),
      );
    const makeRuntime = (arch = "arm64") => provide(MacosVm.make({ arch }));
    const runtime = yield* makeRuntime();
    const makeDriver = () =>
      provide(CuaDriver.make({ arch: "arm64" })).pipe(Effect.provide(settingsLayer));
    return yield* body({
      runtime,
      registry,
      makeRuntime,
      makeDriver,
      vms,
      runs,
      stateDir,
      processes,
      waitForPreparation: Deferred.await(setupFiber).pipe(
        Effect.flatMap(Fiber.await),
        Effect.asVoid,
      ),
      setPull: (effect) => {
        pull = effect;
      },
      setSetup: (effect) => {
        setup = effect;
      },
      waitForBoot: Deferred.await(bootRequested),
      setConsent: (value) => {
        consent = value;
      },
      setIp: (value) => {
        ip = value;
      },
      setSetupExitCode: (value) => {
        setupExitCode = value;
      },
      setMalformedOutput: (command) => {
        malformedOutput = command;
      },
      setFreeKib: (kib) => {
        freeKib = kib;
      },
      setBootFailure: (value) => {
        bootFailure = value;
      },
      change: (patch) =>
        Effect.gen(function* () {
          settings = { ...settings, ...patch };
          const drained = yield* Deferred.make<void>();
          yield* Queue.offer(events, { value: settings, drained });
          yield* Deferred.await(drained);
        }),
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "paperplane-macos-vm-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

it.effect(
  "streams setup and leased desktops and revokes viewers on verify, close and release",
  () =>
    harness(({ runtime, registry, waitForPreparation, vms }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const pull = yield* Stream.toPull(registry.changes);
          yield* pull;
          yield* runtime.prepare;
          yield* waitForPreparation;
          const setup = (yield* pull)[0]!.desktops[0]!;
          expect(setup).toMatchObject({ kind: "macos-vm", role: "setup", threadId: null });
          vms.get(golden)!.vncUrl = "vnc://:secret@127.0.0.1:5900";
          expect(yield* registry.viewer(setup.id)).toEqual({
            path: `/api/computer-use/desktops/${setup.id}/vnc`,
            password: "secret",
          });
          const connection = yield* registry.connection(setup.id);
          yield* runtime.verify;
          yield* connection.closed;
          expect((yield* pull)[0]!.desktops).toEqual([]);
          yield* runtime.lease("thread:one");
          const leased = (yield* pull)[0]!.desktops[0]!;
          expect(leased).toMatchObject({ kind: "macos-vm", role: "thread", threadId: "one" });
          expect(yield* registry.viewer(leased.id)).toEqual({
            path: `/api/computer-use/desktops/${leased.id}/vnc`,
            password: new URL(vms.get(work)!.vncUrl!).password,
          });
          const leasedConnection = yield* registry.connection(leased.id);
          yield* runtime.close("thread:one");
          yield* leasedConnection.closed;
          expect((yield* registry.viewer(leased.id).pipe(Effect.flip))._tag).toBe(
            "ComputerDesktopViewerError",
          );
          expect((yield* pull)[0]!.desktops).toEqual([]);
          yield* runtime.lease("thread:two");
          const second = (yield* pull)[0]!.desktops[0]!;
          const secondConnection = yield* registry.connection(second.id);
          yield* runtime.release;
          yield* secondConnection.closed;
          expect((yield* pull)[0]!.desktops).toEqual([]);
          expect((yield* registry.viewer(second.id).pipe(Effect.flip))._tag).toBe(
            "ComputerDesktopViewerError",
          );
        }),
      ),
    ),
);

it("parses Lume download, ETA and image assembly output without exposing raw output", () => {
  expect(
    MacosVm.parseLumeProgress("\x1b[32m[████░░░] 42% | Current: 50 MB/s | ETA: 1:02:03\x1b[0m"),
  ).toEqual({
    phase: "downloading",
    percent: 42,
    etaSeconds: 3723,
  });
  expect(
    MacosVm.parseLumeProgress("[░░░] 0% | Initializing downloads... | ETA: calculating..."),
  ).toEqual({ phase: "downloading", percent: 0 });
  expect(MacosVm.parseLumeProgress("[██░] 80% | ETA: 2:03")).toEqual({
    phase: "downloading",
    percent: 80,
    etaSeconds: 123,
  });
  expect(MacosVm.parseLumeProgress("[███] 100% | ETA: 0:00")).toEqual({
    phase: "unpacking",
    percent: 100,
  });
  for (const message of [
    "Decompressing disk image (gzip, sparse-aware)…",
    "Reassembling disk",
    "Copying OCI image",
  ])
    expect(MacosVm.parseLumeProgress(`[2026-10-18T00:00:00Z] INFO: ${message}`)).toEqual({
      phase: "unpacking",
    });
  expect(MacosVm.parseLumeProgress("unrelated output")).toBeUndefined();
});

it.effect(
  "returns immediately, streams split UTF-8/ANSI progress and polls without processes",
  () =>
    harness(({ runtime, runs, setPull, waitForPreparation }) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const unpack = yield* Deferred.make<void>();
        const unpacked = yield* Deferred.make<void>();
        setPull((input) =>
          Effect.gen(function* () {
            const bytes = new TextEncoder().encode(
              "\r\x1b[32m[████░░] 42% | Current: 50.1 MB/s | ETA: 1:02:03\x1b[0m\r",
            );
            for (let i = 0; i < bytes.length; i++) input.onStdoutChunk?.(bytes.slice(i, i + 1));
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(unpack);
            input.onStdoutChunk?.(
              new TextEncoder().encode("[██] 100% | ETA: 0:00\nINFO: Decompressing disk image…\r"),
            );
            yield* Deferred.succeed(unpacked, undefined);
            yield* Deferred.await(finish);
          }),
        );
        yield* runtime.check;
        yield* runtime.prepare;
        yield* Deferred.await(entered);
        const count = runs.length;
        expect(yield* runtime.check).toMatchObject({
          state: "preparing",
          lumeVersion: "lume 0.6.1",
          freeDiskBytes: 819_200_000_000,
          progress: {
            phase: "downloading",
            percent: 42,
            etaSeconds: 3723,
            startedAt: expect.any(Number),
          },
        });
        yield* runtime.prepare;
        expect((yield* runtime.verify.pipe(Effect.flip)).reason).toBe("preparing");
        expect((yield* runtime.openDisplay.pipe(Effect.flip)).reason).toBe("preparing");
        expect((yield* runtime.lease("a").pipe(Effect.flip)).reason).toBe("preparing");
        expect(runs).toHaveLength(count);
        expect(runs.find((run) => run.args[0] === "pull")).toMatchObject({
          outputMode: "truncate",
          timeout: "12 hours",
        });
        yield* Deferred.succeed(unpack, undefined);
        yield* Deferred.await(unpacked);
        expect(yield* runtime.check).toMatchObject({
          state: "preparing",
          progress: { phase: "unpacking" },
        });
        expect((yield* runtime.openDisplay.pipe(Effect.flip)).reason).toBe("preparing");
        yield* Deferred.succeed(finish, undefined);
        yield* waitForPreparation;
        expect(yield* runtime.check).toMatchObject({ state: "needs-consent" });
        expect(yield* runtime.check).not.toHaveProperty("progress");
        yield* runtime.release;
      }),
    ),
);

it.effect("retains a safe background failure until a new preparation succeeds", () =>
  harness(({ runtime, setPull, waitForPreparation }) =>
    Effect.gen(function* () {
      const pulling = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
      setPull(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(pulling, yield* Effect.fiber);
          return yield* Effect.die("https://user:secret@example.test/private raw process output");
        }),
      );
      yield* runtime.prepare;
      yield* Fiber.await(yield* Deferred.await(pulling));
      const error = new MacosVm.MacosVmError({ reason: "runtime" }).message;
      expect(yield* runtime.check).toMatchObject({ state: "needs-image", lastError: error });
      expect((yield* runtime.check).lastError).not.toContain("secret");
      setPull(() => Effect.void);
      yield* runtime.prepare;
      expect(yield* runtime.check).not.toHaveProperty("lastError");
      yield* waitForPreparation;
      expect(yield* runtime.check).not.toHaveProperty("lastError");
      yield* runtime.release;
    }),
  ),
);

it.effect("cancels a pull, releases its process effect and allows another preparation", () =>
  harness(({ runtime, setPull, waitForPreparation }) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      setPull(() =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      );
      yield* runtime.prepare;
      yield* Deferred.await(entered);
      yield* runtime.cancel;
      expect(yield* Deferred.isDone(interrupted)).toBe(true);
      expect(yield* runtime.check).toMatchObject({ state: "needs-image" });
      expect(yield* runtime.check).not.toHaveProperty("lastError");
      setPull(() => Effect.void);
      yield* runtime.prepare;
      yield* waitForPreparation;
      yield* runtime.cancel;
      expect(yield* runtime.check).toMatchObject({ state: "needs-consent" });
      yield* runtime.release;
    }),
  ),
);

it.effect(
  "opens only the owned running setup desktop during driver installation without sealing or rebooting",
  () =>
    harness(({ runtime, registry, setSetup, vms, runs, stateDir, waitForPreparation }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const entered = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        setSetup(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))));
        yield* runtime.prepare;
        yield* Deferred.await(entered);
        yield* runtime.openDisplay;
        yield* runtime.openDisplay;
        const desktop = Option.getOrThrow(yield* Stream.runHead(registry.changes)).desktops[0]!;
        expect((yield* registry.viewer(desktop.id)).password).toBeTruthy();
        expect((yield* runtime.verify.pipe(Effect.flip)).reason).toBe("preparing");
        expect(yield* fs.exists(`${stateDir}/computer-use/macos/sealed`)).toBe(false);
        expect(runs.filter((run) => run.args[0] === "run")).toHaveLength(1);
        expect(runs.some((run) => run.args[0] === "stop" || run.args[0] === "delete")).toBe(false);
        vms.get(golden)!.status = "stopped";
        expect((yield* runtime.openDisplay.pipe(Effect.flip)).reason).toBe("display");
        vms.get(golden)!.status = "running";
        const ownerPath = `${stateDir}/computer-use/macos/owner.json`;
        const owner = yield* fs.readFileString(ownerPath);
        yield* fs.writeFileString(ownerPath, json({ ...JSON.parse(owner), token: "not-ours" }));
        expect((yield* runtime.openDisplay.pipe(Effect.flip)).reason).toBe("ownership");
        yield* fs.writeFileString(ownerPath, owner);
        yield* Deferred.succeed(finish, undefined);
        yield* waitForPreparation;
        expect(yield* runtime.check).toMatchObject({ state: "needs-consent" });
        yield* runtime.release;
      }),
    ),
);

it.effect("cancel stops a booted golden VM and remove cancels driver installation", () =>
  harness(({ runtime, setSetup, vms, stateDir }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const entered = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      setSetup(
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      );
      yield* runtime.prepare;
      yield* Deferred.await(entered);
      expect(yield* runtime.check).toMatchObject({
        state: "preparing",
        progress: { phase: "installing-driver" },
      });
      yield* runtime.cancel;
      expect(yield* Deferred.isDone(interrupted)).toBe(true);
      expect(vms.get(golden)?.status).toBe("stopped");
      expect(
        JSON.parse(yield* fs.readFileString(`${stateDir}/computer-use/macos/owner.json`)),
      ).toMatchObject({ preparing: false });
      yield* runtime.prepare;
      yield* runtime.remove;
      expect(vms.size).toBe(0);
      expect(yield* runtime.check).toMatchObject({ state: "needs-image" });
      yield* runtime.release;
    }),
  ),
);

it.effect("service scope shutdown interrupts preparation without recording a failure", () =>
  harness(({ makeRuntime, setPull }) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      setPull(() =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const scoped = yield* makeRuntime();
          yield* scoped.prepare;
          yield* Deferred.await(entered);
        }),
      );
      expect(yield* Deferred.isDone(interrupted)).toBe(true);
    }),
  ),
);

it.effect("ProcessRunner interruption terminates the child it spawned", () =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.make();
    const started = yield* Deferred.make<number>();
    let text = "";
    const fiber = yield* runner
      .run({
        command: process.execPath,
        args: ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"],
        onStdoutChunk: (chunk) => {
          text += new TextDecoder().decode(chunk);
          if (text.includes("\n"))
            Deferred.doneUnsafe(started, Effect.succeed(Number(text.trim())));
        },
      })
      .pipe(Effect.forkChild);
    const pid = yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    // The PID is captured from our own child; never inspect or signal an unrelated process.
    expect(() => process.kill(pid, 0)).toThrow();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "prepare control returns preparing and cancel control does not wait for the download",
  () =>
    harness(({ makeDriver, setPull }) =>
      Effect.gen(function* () {
        setPull(() => Effect.never);
        const driver = yield* makeDriver();
        expect(yield* driver.control({ action: "prepare-vm" })).toMatchObject({
          readiness: { vm: { state: "preparing" } },
        });
        expect(yield* driver.control({ action: "cancel-prepare-vm" })).toMatchObject({
          readiness: { vm: { state: "needs-image" } },
        });
      }),
    ),
);

it.effect(
  "discovers Lume, reports image requirements and rejects Intel without running anything",
  () =>
    harness(({ runtime, makeRuntime, runs }) =>
      Effect.gen(function* () {
        expect(yield* runtime.check).toMatchObject({
          state: "needs-image",
          lumeVersion: "lume 0.6.1",
          capacity: 1,
          freeDiskBytes: 819_200_000_000,
        });
        const intel = yield* makeRuntime("x64");
        const count = runs.length;
        expect(yield* intel.check).toMatchObject({ state: "unavailable" });
        expect(runs).toHaveLength(count);
        yield* runtime.release;
      }),
    ),
);

it.effect("refuses to prepare below the required free disk unless the golden VM exists", () =>
  harness(({ runtime, vms, runs, setFreeKib, waitForPreparation }) =>
    Effect.gen(function* () {
      // 100 GB free, 150 GB required.
      setFreeKib(100_000_000_000 / 1024);
      const refused = yield* runtime.prepare.pipe(Effect.flip);
      expect(refused.reason).toBe("disk");
      expect(refused.message).toContain("needs about 150 GB; 100.0 GB is free");
      expect(runs.some((run) => run.args[0] === "pull")).toBe(false);
      expect((yield* runtime.check).progress).toBeUndefined();

      // Exactly the requirement is enough.
      setFreeKib(150_000_000_000 / 1024);
      yield* runtime.prepare;
      yield* waitForPreparation;
      expect(runs.some((run) => run.args[0] === "pull")).toBe(true);

      // Re-preparing an existing golden VM never pulls, so it needs no extra space.
      expect(vms.has(golden)).toBe(true);
      setFreeKib(1);
      yield* runtime.prepare;
    }),
  ),
);

it.effect("prepares when free disk cannot be read", () =>
  harness(({ runtime, runs, setFreeKib, waitForPreparation }) =>
    Effect.gen(function* () {
      setFreeKib(null);
      expect((yield* runtime.check).freeDiskBytes).toBeUndefined();
      yield* runtime.prepare;
      yield* waitForPreparation;
      expect(runs.some((run) => run.args[0] === "pull")).toBe(true);
    }),
  ),
);

it.effect("reports a disk shortage through the prepare control", () =>
  harness(({ makeDriver, setFreeKib }) =>
    Effect.gen(function* () {
      setFreeKib(1_000_000);
      const driver = yield* makeDriver();
      expect((yield* driver.control({ action: "prepare-vm" }).pipe(Effect.flip)).detail).toContain(
        "Not enough free disk space",
      );
    }),
  ),
);

it.effect("reports missing Lume and discovers the home and Homebrew fallbacks", () =>
  harness(({ runtime, makeRuntime, stateDir, runs }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(`${stateDir}/bin/lume`);
      expect(yield* runtime.check).toMatchObject({
        state: "missing-lume",
        installCommand: '/bin/bash -c "$(curl -fsSL https://cua.ai/lume/install.sh)"',
      });
      yield* fs.makeDirectory(`${stateDir}/.local/bin`, { recursive: true });
      yield* fs.writeFileString(`${stateDir}/.local/bin/lume`, "fake");
      expect(yield* runtime.check).toMatchObject({
        state: "needs-image",
        lumeVersion: "lume 0.6.1",
      });
      yield* runtime.release;
      yield* fs.remove(`${stateDir}/.local/bin/lume`);
      const homebrew = yield* makeRuntime().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: (file) =>
            file === "/opt/homebrew/bin/lume" ? Effect.succeed(true) : fs.exists(file),
        }),
      );
      expect(yield* homebrew.check).toMatchObject({
        state: "needs-image",
        lumeVersion: "lume 0.6.1",
      });
      expect(
        runs.some((run) => run.command === "/opt/homebrew/bin/lume" && run.args[0] === "--version"),
      ).toBe(true);
      yield* homebrew.release;
      expect(runs.every((run) => run.args[0] !== "pull")).toBe(true);
    }),
  ),
);

it.effect("installs Lume only on explicit control and never falls back to the host", () =>
  harness(({ makeDriver, stateDir, runs }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(`${stateDir}/bin/lume`);
      const driver = yield* makeDriver();
      expect(yield* driver.status).toMatchObject({
        status: "stopped",
        readiness: { mode: "isolated-vm", vm: { state: "missing-lume" } },
      });
      expect(
        (yield* driver.call("click", {}, ThreadId.make("missing-vm")).pipe(Effect.flip)).detail,
      ).toContain("Lume is missing");
      expect(runs).toHaveLength(0);
      yield* driver.control({ action: "install" });
      expect(runs.find((run) => run.command === "/bin/bash")?.args).toEqual([
        "-c",
        'script="$(curl -fsSL https://cua.ai/lume/install.sh)" && /bin/bash -c "$script"',
      ]);
      expect(runs.some((run) => run.args[0] === "pull")).toBe(false);
      expect(yield* driver.status).toMatchObject({ readiness: { vm: { state: "needs-image" } } });
    }),
  ),
);

it.effect("open display boots/registers setup inline; viewer validates private credentials", () =>
  harness(({ runtime, registry, vms, runs, stateDir }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      expect((yield* runtime.openDisplay.pipe(Effect.flip)).reason).toBe("display");
      const vm = record(golden);
      vms.set(golden, vm);
      yield* runtime.openDisplay;
      yield* runtime.openDisplay;
      expect(vm.status).toBe("running");
      expect(runs.filter((run) => run.args[0] === "run")).toHaveLength(1);
      expect(runs.some((run) => run.command === "/usr/bin/open")).toBe(false);
      expect(
        JSON.parse(yield* fs.readFileString(`${stateDir}/computer-use/macos/owner.json`)),
      ).toMatchObject({ preparing: true });
      const desktop = Option.getOrThrow(yield* Stream.runHead(registry.changes)).desktops[0]!;
      expect((yield* registry.viewer(desktop.id)).password).toBeTruthy();
      for (const url of [
        undefined,
        null,
        "invalid",
        "https://:secret@127.0.0.1:5900",
        "vnc://:secret@example.com:5900",
        "vnc://:secret@192.168.64.2:5900",
        "vnc://:secret@127.0.0.1.evil.test:5900",
        "vnc://127.0.0.1:5900",
        "vnc://:secret@127.0.0.1",
        "vnc://:secret@127.0.0.1:0",
        "vnc://:secret@127.0.0.1:65536",
        "vnc://:%ZZ@127.0.0.1:5900",
      ]) {
        vm.vncUrl = url ?? null;
        const error = yield* registry.viewer(desktop.id).pipe(Effect.flip);
        expect(error._tag).toBe("ComputerDesktopViewerError");
        expect(error).not.toHaveProperty("cause");
        expect(JSON.stringify(error)).not.toContain("secret");
      }
      for (const host of ["localhost", "[::1]", "127.0.0.2"]) {
        vm.vncUrl = `vnc://:secret@${host}:5900`;
        expect((yield* registry.viewer(desktop.id)).password).toBe("secret");
        const connection = yield* registry.connection(desktop.id);
        expect(yield* connection.endpoint).toEqual({
          kind: "tcp",
          host: host === "[::1]" ? "::1" : host,
          port: 5900,
          password: "secret",
        });
      }
      yield* fs.writeFileString(`${stateDir}/computer-use/macos/owner.json`, "{}");
      expect((yield* registry.viewer(desktop.id).pipe(Effect.flip))._tag).toBe(
        "ComputerDesktopViewerError",
      );
    }),
  ),
);

it.effect("does not propagate credentialed process failures from setup or work boots", () =>
  harness(({ runtime, vms, runs, setBootFailure, waitForPreparation }) =>
    Effect.gen(function* () {
      vms.set(golden, record(golden));
      setBootFailure(true);
      const setupError = yield* runtime.openDisplay.pipe(Effect.flip);
      expect(setupError.reason).toBe("display");
      expect(setupError).not.toHaveProperty("cause");
      setBootFailure(false);
      yield* runtime.prepare;
      yield* waitForPreparation;
      yield* runtime.verify;
      setBootFailure(true);
      const workError = yield* runtime.lease("thread:failure").pipe(Effect.flip);
      expect(workError.reason).toBe("runtime");
      expect(workError).not.toHaveProperty("cause");
      const publicErrors = JSON.stringify({ setupError, workError, status: yield* runtime.check });
      for (const run of runs.filter((run) => run.args[0] === "run")) {
        const password = run.args[run.args.indexOf("--vnc-password") + 1]!;
        expect(publicErrors).not.toContain(password);
      }
      yield* runtime.release;
    }),
  ),
);

for (const command of ["ls", "get"] as const) {
  it.effect(`does not retain credentialed Lume ${command} decode failures`, () =>
    harness(({ runtime, vms, setMalformedOutput, waitForPreparation }) =>
      Effect.gen(function* () {
        vms.set(golden, record(golden));
        yield* runtime.prepare;
        yield* waitForPreparation;
        yield* runtime.verify;
        setMalformedOutput(command);
        const error = yield* runtime.lease("thread:decode").pipe(Effect.flip);
        expect(error.reason).toBe("runtime");
        expect(error).not.toHaveProperty("cause");
        expect(JSON.stringify(error)).not.toContain("decode-secret");
        setMalformedOutput(null);
        yield* runtime.release;
      }),
    ),
  );
}

it.effect("verify boots an unsealed stopped golden VM before checking consent", () =>
  harness(({ runtime, vms, runs, setConsent }) =>
    Effect.gen(function* () {
      vms.set(golden, record(golden));
      setConsent({ accessibility: false, screen_recording: false });
      expect((yield* runtime.verify.pipe(Effect.flip)).reason).toBe("consent");
      expect(vms.get(golden)?.status).toBe("running");
      const boot = runs.findIndex((run) => run.args[0] === "run");
      expect(boot).toBeGreaterThan(-1);
      expect(runs.findIndex((run) => run.command === "/usr/bin/ssh")).toBeGreaterThan(boot);
      yield* runtime.release;
      expect(vms.get(golden)?.status).toBe("stopped");
    }),
  ),
);

for (const status of ["running", "stopped"]) {
  it.effect(`removes a ${status} golden VM awaiting consent, including unrecorded work`, () =>
    harness(({ runtime, vms, runs }) =>
      Effect.gen(function* () {
        for (const unrecorded of [false, true]) {
          vms.set(golden, { ...record(golden), status });
          if (unrecorded) vms.set(work, { ...record(work), status: "running" });
          expect(yield* runtime.check).toMatchObject({
            state: unrecorded ? "unavailable" : "needs-consent",
          });
          yield* runtime.remove;
          expect(vms.size).toBe(0);
          expect(yield* runtime.check).toMatchObject({ state: "needs-image" });
        }
        expect(runs.filter((run) => run.args[0] === "delete").map((run) => run.args[1])).toEqual([
          golden,
          work,
          golden,
        ]);
        yield* runtime.release;
      }),
    ),
  );
}

it.effect("does not discard unrecorded clones during ordinary status or shutdown", () =>
  harness(({ runtime, vms }) =>
    Effect.gen(function* () {
      vms.set(work, record(work));
      expect(yield* runtime.check).toMatchObject({ state: "unavailable" });
      yield* runtime.release;
      expect(vms.has(work)).toBe(true);
    }),
  ),
);

it.effect(
  "prepares without host clipboard and with automatic setup, verifies app-owned consent, then seals",
  () =>
    harness(({ runtime, runs, setConsent, vms, stateDir, waitForPreparation }) =>
      Effect.gen(function* () {
        yield* runtime.prepare;
        yield* waitForPreparation;
        expect(runs.find((run) => run.args[0] === "pull")?.args.slice(0, 3)).toEqual([
          "pull",
          "macos-tahoe-cua:26.5.2",
          golden,
        ]);
        expect(runs.find((run) => run.args[0] === "run")?.args).toEqual(
          expect.arrayContaining(["--detach", "--display", "none", "--vnc", "enabled"]),
        );
        const status = yield* runtime.check;
        expect(status).toMatchObject({
          state: "needs-consent",
          diskBytes: 42_000,
          virtualDiskBytes: 150_000_000_000,
          memoryBytes: 8_589_934_592,
        });
        expect(runs.some((run) => run.args.includes("--clipboard"))).toBe(false);
        expect(status.setupCommand).toContain("ssh-ed25519 AAAATEST paperplane-cua");
        expect(status.setupCommand).toContain("authorized_keys");
        const setup = runs.find((run) => run.args[0] === "ssh");
        expect(setup?.args.slice(0, 6)).toEqual([
          "ssh",
          golden,
          "--storage",
          `${stateDir}/computer-use/macos/vms`,
          "--timeout",
          "600",
        ]);
        expect(setup?.timeout).toBe("10 minutes");
        expect(setup?.args).toHaveLength(7);
        const script = setup!.args[6]!;
        expect(script).toContain("grep -qxF 'ssh-ed25519 AAAATEST paperplane-cua'");
        expect(script).toContain('/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"');
        expect(script).toContain("cua-driver telemetry disable");
        expect(script).toContain("cua-driver permissions grant");
        expect(status.setupCommand).toContain(script);
        expect(status.setupCommand).toContain("list_apps '{}'");
        expect(status.setupCommand).toContain("call get_desktop_state '{}'");
        expect(script).not.toContain("list_apps");
        const bootAddress = runs.findIndex(
          (run, index) =>
            run.args[0] === "get" &&
            run.args[1] === golden &&
            index > runs.findIndex((entry) => entry.args[0] === "run"),
        );
        expect(bootAddress).toBeGreaterThan(runs.findIndex((run) => run.args[0] === "run"));
        expect(runs.indexOf(setup!)).toBeGreaterThan(bootAddress);
        expect(runs.some((run) => run.args.includes("--password"))).toBe(false);
        for (const value of [
          null,
          {},
          {
            accessibility: true,
            screen_recording: false,
            source: { attribution: "driver-daemon" },
          },
          { accessibility: true, screen_recording: true, source: { attribution: "unknown" } },
        ]) {
          setConsent(value);
          expect((yield* runtime.verify.pipe(Effect.flip)).reason).toBe("consent");
          expect(vms.get(golden)?.status).toBe("running");
        }
        setConsent({
          accessibility: true,
          screen_recording: true,
          source: { attribution: "driver-daemon" },
        });
        yield* runtime.verify;
        expect(yield* runtime.check).toMatchObject({ state: "ready" });
        expect(yield* runtime.check).not.toHaveProperty("displayUrl");
        expect(vms.get(golden)?.status).toBe("stopped");
        yield* runtime.release;
      }),
    ),
);

it.effect("keeps preparation awaiting consent with manual setup when Lume SSH fails", () =>
  harness(({ runtime, runs, setSetupExitCode, vms, waitForPreparation }) =>
    Effect.gen(function* () {
      setSetupExitCode(1);
      yield* runtime.prepare;
      yield* waitForPreparation;
      expect(runs.some((run) => run.args[0] === "ssh")).toBe(true);
      expect(yield* runtime.check).toMatchObject({
        state: "needs-consent",
        setupCommand: expect.stringContaining("cua-driver permissions grant"),
      });
      expect(vms.get(golden)?.status).toBe("running");
      yield* runtime.release;
    }),
  ),
);

it.effect("leases exclusively, reuses the VM for the same thread, and resets between leases", () =>
  harness(({ runtime, registry, vms, runs, stateDir, waitForPreparation }) =>
    Effect.gen(function* () {
      expect((yield* runtime.lease("a").pipe(Effect.flip)).reason).toBe("not-ready");
      yield* runtime.prepare;
      yield* waitForPreparation;
      yield* runtime.verify;
      const transport = yield* runtime.lease("a");
      expect(transport.command).toBe("/usr/bin/ssh");
      expect(transport.args).toEqual(
        expect.arrayContaining([
          "BatchMode=yes",
          "lume@192.168.64.2",
          "/Users/lume/.local/bin/cua-driver",
          "mcp",
        ]),
      );
      expect(yield* runtime.lease("a")).toEqual(transport);
      expect(runs.filter((run) => run.args[0] === "clone")).toHaveLength(1);
      expect((yield* runtime.lease("b").pipe(Effect.flip)).reason).toBe("capacity");
      yield* runtime.close("b");
      expect(vms.has(work)).toBe(true);
      yield* runtime.close("a");
      expect(vms.has(work)).toBe(false);
      yield* runtime.lease("b");
      expect(runs.filter((run) => run.args[0] === "clone")).toHaveLength(2);
      const boots = runs.filter((run) => run.args[0] === "run");
      const passwords = boots.map((run) => run.args[run.args.indexOf("--vnc-password") + 1]!);
      expect(boots).toHaveLength(3);
      expect(new Set(passwords).size).toBe(boots.length);
      for (const run of boots) {
        expect(run.args).toEqual(
          expect.arrayContaining([
            "--detach",
            "--display",
            "none",
            "--vnc",
            "enabled",
            "--network",
            "nat",
          ]),
        );
        expect(run.args).not.toContain("--clipboard");
        expect(run.args).not.toContain("--vnc-port");
      }
      const fs = yield* FileSystem.FileSystem;
      const publicState = JSON.stringify({
        status: yield* runtime.check,
        desktops: Option.getOrThrow(yield* Stream.runHead(registry.changes)),
        owner: yield* fs.readFileString(`${stateDir}/computer-use/macos/owner.json`),
      });
      for (const password of passwords) {
        expect(password).toMatch(/^[A-Za-z0-9_-]{24}$/);
        expect(publicState).not.toContain(password);
        expect(publicState).not.toContain(password.slice(0, 8));
      }
      yield* runtime.release;
      expect(vms.has(work)).toBe(false);
      expect(vms.has(golden)).toBe(true);
    }),
  ),
);

it.effect(
  "bounds boot address waits with the Effect clock; explicit release discards a partial lease",
  () =>
    harness(({ runtime, setIp, vms, waitForBoot, waitForPreparation }) =>
      Effect.gen(function* () {
        yield* runtime.prepare;
        yield* waitForPreparation;
        yield* runtime.verify;
        setIp(null);
        const boot = yield* runtime.lease("a").pipe(Effect.flip, Effect.forkChild);
        yield* waitForBoot;
        yield* TestClock.adjust("2 minutes");
        expect((yield* Fiber.join(boot)).reason).toBe("runtime");
        yield* runtime.release;
        expect(vms.has(work)).toBe(false);
      }),
    ),
);

it.effect("recovers only dead-server owned clones and never deletes foreign VM names", () =>
  harness(({ runtime, stateDir, vms, runs }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = `${stateDir}/computer-use/macos`;
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(
        `${directory}/owner.json`,
        json({ pid: 1234567, start: "yesterday", token: "old", work: true, preparing: false }),
      );
      vms.set(work, { ...record(work), status: "running" });
      vms.set("personal", record("personal"));
      vms.set("rove-cua-foreign", record("rove-cua-foreign"));
      expect(yield* runtime.check).toMatchObject({ state: "needs-image" });
      expect(vms.has(work)).toBe(false);
      expect(vms.has("personal")).toBe(true);
      expect(vms.has("rove-cua-foreign")).toBe(true);
      expect(runs.filter((run) => run.args[0] === "delete").map((run) => run.args[1])).toEqual([
        work,
      ]);
      yield* runtime.release;
    }),
  ),
);

it.effect(
  "refuses live owners, allows PID-reuse recovery and fails closed for malformed ownership",
  () =>
    harness(({ runtime, stateDir, vms, processes }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = `${stateDir}/computer-use/macos`;
        yield* fs.makeDirectory(directory, { recursive: true });
        processes.set(1234567, "live");
        yield* fs.writeFileString(
          `${directory}/owner.json`,
          json({ pid: 1234567, start: "live", token: "other", work: true, preparing: false }),
        );
        vms.set(work, record(work));
        expect(yield* runtime.check).toMatchObject({ state: "unavailable" });
        expect(vms.has(work)).toBe(true);
        processes.set(1234567, "reused");
        expect(yield* runtime.check).toMatchObject({ state: "needs-image" });
        expect(vms.has(work)).toBe(false);
        yield* runtime.release;
        yield* fs.writeFileString(`${directory}/owner.json`, "broken");
        expect(yield* runtime.check).toMatchObject({ state: "unavailable" });
      }),
    ),
);

it.effect(
  "routes Cua over SSH with isolated policy, preserves idle leases, closes explicitly and releases on mode switch/off/shutdown",
  () =>
    harness(({ makeDriver, vms, change, runs, waitForPreparation }) =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        yield* driver.control({ action: "prepare-vm" });
        yield* waitForPreparation;
        vms.get(golden)!.vncUrl = "vnc://:secret@127.0.0.1:5900";
        yield* driver.control({ action: "open-vm-display" });
        expect(runs.some((run) => run.command === "/usr/bin/open")).toBe(false);
        yield* driver.control({ action: "verify-vm" });
        expect(
          (yield* driver.control({ action: "open-vm-display" }).pipe(Effect.flip)).detail,
        ).toContain("Couldn't open the VM display");
        expect(runs.filter((run) => run.command === "/usr/bin/open")).toHaveLength(0);
        const thread = ThreadId.make("vm-thread");
        const catalog = yield* driver.catalog(thread);
        expect(catalog.policy).toBe("isolated-desktop");
        expect(catalog.tools.some((tool) => tool.name === "close_desktop")).toBe(true);
        expect(transports.at(-1)?.command).toBe("/usr/bin/ssh");
        yield* TestClock.adjust(CuaDriver.IDLE_TIMEOUT);
        expect(vms.has(work)).toBe(true);
        yield* driver.call("click", {}, thread);
        yield* driver.call("close_desktop", {}, thread);
        expect(vms.has(work)).toBe(false);
        yield* driver.call("click", {}, thread);
        yield* change({ computerUseMacosMode: "host" });
        expect(vms.has(work)).toBe(false);
        yield* change({ computerUseMacosMode: "isolated-vm" });
        yield* driver.call("click", {}, thread);
        yield* change({ enableAgentComputerUse: false });
        expect(vms.has(work)).toBe(false);
        expect((yield* driver.call("click", {}, thread).pipe(Effect.flip)).detail).toContain("off");
        yield* change({ enableAgentComputerUse: true });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const scoped = yield* makeDriver();
            yield* scoped.call("click", {}, thread);
          }),
        );
        expect(vms.has(work)).toBe(false);
        yield* driver.control({ action: "remove-vm" });
        expect(vms.has(golden)).toBe(false);
      }),
    ),
);
