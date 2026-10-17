import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  type ServerSettings as Settings,
} from "@rove-code/contracts";
import {
  Environment as HostProcessEnvironment,
  Platform as HostProcessPlatform,
} from "@rove-code/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
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
    makeRuntime: (
      arch?: string,
    ) => Effect.Effect<
      MacosVm.MacosVm["Service"],
      never,
      FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig
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
    waitForBoot: Effect.Effect<void>;
    waitForDisplay: Effect.Effect<void>;
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
    const bootRequested = yield* Deferred.make<void>();
    const displayRequested = yield* Deferred.make<void>();
    const runs: Array<ProcessRunner.ProcessRunInput> = [];
    const processes = new Map([[process.pid, "today\n"]]);
    let ip: string | null = "192.168.64.2";
    let setupExitCode = 0;
    let consent: unknown = {
      accessibility: true,
      screen_recording: true,
      source: { attribution: "driver-daemon" },
    };
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.gen(function* () {
          runs.push(input);
          const args = input.args;
          if (input.command === "/bin/ps")
            return output(
              processes.get(Number(args[1])) ?? "",
              processes.has(Number(args[1])) ? 0 : 1,
            );
          if (input.command === "/bin/df")
            return output(
              "Filesystem 1024-blocks Used Available Capacity Mounted on\ndisk 900000000 100000000 800000000 10% /\n",
            );
          if (input.command === "/usr/bin/ssh-keygen") {
            const key = args[args.indexOf("-f") + 1];
            yield* fs.writeFileString(key!, "private");
            yield* fs.writeFileString(`${key}.pub`, "ssh-ed25519 AAAATEST rove-cua\n");
            return output();
          }
          if (input.command === "/bin/bash") {
            yield* fs.writeFileString(bin, "fake installed lume");
            return output();
          }
          if (input.command === "/usr/bin/ssh") return output(json(consent));
          if (input.command === "/usr/bin/open") return output();
          if (!input.command.endsWith("/lume"))
            throw new Error(`Unexpected command ${input.command}`);
          switch (args[0]) {
            case "--version":
              return output("lume 0.6.1\n");
            case "ls":
              return output(json([...vms.values()]));
            case "ssh":
              return output("", setupExitCode);
            case "get":
              if (
                args[1] === golden &&
                vms.get(golden)?.status === "running" &&
                !vms.get(golden)?.vncUrl
              )
                yield* Deferred.succeed(displayRequested, undefined);
              if (args[1] === work && ip === null)
                yield* Deferred.succeed(bootRequested, undefined);
              return output(json(vms.has(args[1]!) ? [vms.get(args[1]!)] : []));
            case "pull":
              vms.set(args[2]!, record(args[2]!));
              return output();
            case "clone":
              vms.set(args[2]!, record(args[2]!));
              return output();
            case "run": {
              const vm = vms.get(args[1]!)!;
              vm.status = "running";
              vm.ipAddress = ip;
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
        }).pipe(Effect.orDie),
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
    const provide = <A2, E2, R>(effect: Effect.Effect<A2, E2, R>) =>
      effect.pipe(
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
      makeRuntime,
      makeDriver,
      vms,
      runs,
      stateDir,
      processes,
      waitForBoot: Deferred.await(bootRequested),
      waitForDisplay: Deferred.await(displayRequested),
      setConsent: (value) => {
        consent = value;
      },
      setIp: (value) => {
        ip = value;
      },
      setSetupExitCode: (value) => {
        setupExitCode = value;
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
      ServerConfig.layerTest(process.cwd(), { prefix: "rove-macos-vm-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
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

it.effect("boots and opens the credentialed display only for a golden VM awaiting consent", () =>
  harness(({ runtime, vms, runs }) =>
    Effect.gen(function* () {
      expect((yield* runtime.openDisplay.pipe(Effect.flip)).reason).toBe("display");
      const vm = record(golden);
      vm.vncUrl = "vnc://user:secret@127.0.0.1:5900?password=secret#secret";
      vms.set(golden, vm);
      yield* runtime.openDisplay;
      expect(vm.status).toBe("running");
      expect(runs.filter((run) => run.args[0] === "run")).toHaveLength(1);
      expect(runs.filter((run) => run.command === "/usr/bin/open")).toMatchObject([
        { args: [vm.vncUrl] },
      ]);
      expect(yield* runtime.check).not.toHaveProperty("displayUrl");
      for (const url of [
        "invalid",
        "https://127.0.0.1",
        "vnc://example.com",
        "vnc://192.168.65.2",
        "vnc://192.168.64.2.evil.test",
      ]) {
        vm.vncUrl = url;
        const error = yield* runtime.openDisplay.pipe(Effect.flip);
        expect(error.reason).toBe("display");
        expect(error).not.toHaveProperty("cause");
        expect(error.message).not.toContain("secret");
      }
      expect(runs.filter((run) => run.args[0] === "run")).toHaveLength(1);
      expect(runs.filter((run) => run.command === "/usr/bin/open")).toHaveLength(1);
      for (const host of ["localhost", "[::1]", "127.0.0.2", "192.168.64.2"]) {
        vm.vncUrl = `vnc://:secret@${host}:5900`;
        yield* runtime.openDisplay;
        expect(runs.at(-1)).toMatchObject({ command: "/usr/bin/open", args: [vm.vncUrl] });
      }
      vm.vncUrl = "vnc://:secret@127.0.0.1:5900";
      vms.set(work, record(work));
      expect(yield* runtime.check).toMatchObject({ state: "unavailable" });
      expect((yield* runtime.openDisplay.pipe(Effect.flip)).reason).toBe("display");
      expect(runs.filter((run) => run.command === "/usr/bin/open")).toHaveLength(5);
    }),
  ),
);

for (const vncUrl of [undefined, null]) {
  it.effect(`bounds the display wait when Lume reports ${vncUrl}`, () =>
    harness(({ runtime, vms, runs, waitForDisplay }) =>
      Effect.gen(function* () {
        vms.set(golden, { ...record(golden), ...(vncUrl === null ? { vncUrl } : {}) });
        const opening = yield* runtime.openDisplay.pipe(Effect.flip, Effect.forkChild);
        yield* waitForDisplay;
        yield* TestClock.adjust("2 minutes");
        const error = yield* Fiber.join(opening);
        expect(error.reason).toBe("display");
        expect(error).not.toHaveProperty("cause");
        expect(runs.some((run) => run.command === "/usr/bin/open")).toBe(false);
        yield* runtime.release;
      }),
    ),
  );
}

it.effect(
  "waits for Lume to publish the golden display after boot and records crash ownership",
  () =>
    harness(({ runtime, vms, runs, stateDir, waitForDisplay }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const vm = record(golden);
        vms.set(golden, vm);
        const opening = yield* runtime.openDisplay.pipe(Effect.forkChild);
        yield* waitForDisplay;
        expect(runs.some((run) => run.command === "/usr/bin/open")).toBe(false);
        expect(
          JSON.parse(yield* fs.readFileString(`${stateDir}/computer-use/macos/owner.json`)),
        ).toMatchObject({ preparing: true });
        vm.vncUrl = "vnc://:secret@192.168.64.2:5900";
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(opening);
        expect(runs.at(-1)).toMatchObject({ command: "/usr/bin/open", args: [vm.vncUrl] });
        yield* runtime.release;
        expect(vm.status).toBe("stopped");
      }),
    ),
);

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
  "prepares with clipboard and automatic setup, verifies app-owned consent, then seals",
  () =>
    harness(({ runtime, runs, setConsent, vms, stateDir }) =>
      Effect.gen(function* () {
        yield* runtime.prepare;
        expect(runs.find((run) => run.args[0] === "pull")?.args.slice(0, 3)).toEqual([
          "pull",
          "macos-tahoe-cua:26.5.2",
          golden,
        ]);
        expect(runs.find((run) => run.args[0] === "run")?.args).toEqual(
          expect.arrayContaining(["--detach", "--display", "vnc", "--clipboard"]),
        );
        const status = yield* runtime.check;
        expect(status).toMatchObject({
          state: "needs-consent",
          diskBytes: 42_000,
          virtualDiskBytes: 150_000_000_000,
          memoryBytes: 8_589_934_592,
        });
        expect(status.setupCommand).toContain("ssh-ed25519 AAAATEST rove-cua");
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
        expect(script).toContain("grep -qxF 'ssh-ed25519 AAAATEST rove-cua'");
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
  harness(({ runtime, runs, setSetupExitCode, vms }) =>
    Effect.gen(function* () {
      setSetupExitCode(1);
      yield* runtime.prepare;
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
  harness(({ runtime, vms, runs }) =>
    Effect.gen(function* () {
      expect((yield* runtime.lease("a").pipe(Effect.flip)).reason).toBe("not-ready");
      yield* runtime.prepare;
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
      yield* runtime.release;
      expect(vms.has(work)).toBe(false);
      expect(vms.has(golden)).toBe(true);
    }),
  ),
);

it.effect(
  "bounds boot address waits with the Effect clock; explicit release discards a partial lease",
  () =>
    harness(({ runtime, setIp, vms, waitForBoot }) =>
      Effect.gen(function* () {
        yield* runtime.prepare;
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
    harness(({ makeDriver, vms, change, runs }) =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        yield* driver.control({ action: "prepare-vm" });
        vms.get(golden)!.vncUrl = "vnc://:secret@127.0.0.1:5900";
        yield* driver.control({ action: "open-vm-display" });
        expect(runs.filter((run) => run.command === "/usr/bin/open")).toMatchObject([
          { args: ["vnc://:secret@127.0.0.1:5900"] },
        ]);
        yield* driver.control({ action: "verify-vm" });
        expect(
          (yield* driver.control({ action: "open-vm-display" }).pipe(Effect.flip)).detail,
        ).toContain("Couldn't open the VM display");
        expect(runs.filter((run) => run.command === "/usr/bin/open")).toHaveLength(1);
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
