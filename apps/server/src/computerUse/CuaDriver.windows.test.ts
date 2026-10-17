import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@rove-code/contracts";
import {
  Environment as HostProcessEnvironment,
  Platform as HostProcessPlatform,
} from "@rove-code/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CuaDriver from "./CuaDriver.ts";
import { WINDOWS_SOCKET, windowsVerificationScript } from "./WindowsDriver.ts";

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
    connect() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
    getInstructions() {
      return "Driver guidance";
    }
    listTools() {
      return Promise.resolve({
        tools: [
          { name: "check_permissions", inputSchema: { type: "object" } },
          { name: "list_apps", inputSchema: { type: "object" } },
        ],
      });
    }
    callTool() {
      return Promise.resolve({ content: [{ type: "text", text: "ok" }] });
    }
  },
}));

const output = (code = 0, stdout = ""): ProcessRunner.ProcessRunOutput => ({
  code: ChildProcessSpawner.ExitCode(code),
  stdout,
  stderr: "",
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const withWindows = <A, E>(
  options: {
    installed?: boolean;
    running?: boolean;
    path?: boolean;
    verified?: boolean;
    kickFails?: boolean;
    signedRelease?: boolean;
  },
  body: (harness: {
    driver: CuaDriver.CuaDriver["Service"];
    runs: ProcessRunner.ProcessRunInput[];
    probes: string[];
    executable: string;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    transports.length = 0;
    const path = yield* Path.Path;
    const canonical = path.join("local", "Programs", "Cua", "cua-driver", "bin", "cua-driver.exe");
    const executable = options.path ? path.join("path-bin", "cua-driver.exe") : canonical;
    let installed = options.installed ?? true;
    let running = options.running ?? true;
    const runs: ProcessRunner.ProcessRunInput[] = [];
    const probes: string[] = [];
    const realFs = yield* FileSystem.FileSystem;
    const fs = FileSystem.FileSystem.of({
      ...realFs,
      exists: (candidate) => {
        probes.push(candidate);
        return Effect.succeed(installed && candidate === executable);
      },
      realPath: () =>
        Effect.succeed(
          options.signedRelease
            ? String.raw`C:\Users\test\.cua-driver\packages\releases\0.36.0-x86_64-pc-windows-msvc\cua-driver.exe`
            : String.raw`C:\Users\test\.cua-driver\packages\releases\0.21.0-x86_64-pc-windows-msvc\cua-driver.exe`,
        ),
    });
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          runs.push(input);
          if (input.command === "powershell.exe") {
            if (input.args.at(-1)?.includes("install.ps1")) {
              installed = true;
              return output();
            }
            return output(options.verified === false ? 1 : 0);
          }
          if (input.args[0] === "status") return output(running ? 0 : 1);
          if (input.args[0] === "autostart") {
            if (options.kickFails) return output(1);
            if (input.args[1] === "kick") running = true;
          }
          if (input.args[0] === "--version") return output(0, "cua-driver 0.21.0");
          if (input.args[0] === "telemetry") return output(0, '{"enabled":false}');
          return output();
        }),
    });
    const driver = yield* CuaDriver.make().pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
    );
    return yield* body({ driver, runs, probes, executable });
  }).pipe(
    Effect.scoped,
    Effect.provideService(HostProcessPlatform, "win32"),
    Effect.provideService(HostProcessEnvironment, {
      LOCALAPPDATA: "local",
      PATH: "missing;path-bin",
    }),
    Effect.provide([
      ServerSettings.layerTest({ enableAgentComputerUse: true }),
      NodeServices.layer,
    ]),
  );

it.effect("never stops the Scheduled Task's daemon when Rove's scope closes", () =>
  Effect.gen(function* () {
    const runs = yield* withWindows({}, ({ driver, runs }) =>
      Effect.gen(function* () {
        yield* driver.catalog;
        return runs;
      }),
    );
    expect(runs.some((r) => r.args[0] === "stop")).toBe(false);
  }),
);

for (const fromPath of [false, true]) {
  it.effect(
    `resolves Windows ${fromPath ? "PATH first" : "LOCALAPPDATA after PATH"}, verifies before execution, and proxies the interactive pipe`,
    () =>
      withWindows({ path: fromPath }, ({ driver, runs, probes, executable }) =>
        Effect.gen(function* () {
          expect(yield* driver.status).toMatchObject({
            status: "running",
            readiness: { platform: "win32", permissions: null },
          });
          expect(probes.slice(0, fromPath ? 2 : 3)).toEqual(
            fromPath
              ? ["missing", "path-bin"].map((p) =>
                  `${p}/cua-driver.exe`.replaceAll("/", process.platform === "win32" ? "\\" : "/"),
                )
              : ["missing/cua-driver.exe", "path-bin/cua-driver.exe", executable].map((p) =>
                  p.replaceAll("/", process.platform === "win32" ? "\\" : "/"),
                ),
          );
          expect(runs[0]?.command).toBe("powershell.exe");
          expect(runs[0]?.args.at(-1)).toContain("Get-FileHash");
          const catalog = yield* driver.catalog;
          expect(catalog.platform).toBe("win32");
          expect(catalog.policy).toBe("background-only");
          expect(catalog.tools.map((t) => t.name)).not.toContain("check_permissions");
          expect(transports[0]).toMatchObject({
            command: executable,
            args: ["mcp", "--socket", WINDOWS_SOCKET],
          });
          yield* driver.call("list_apps", {}, ThreadId.make("windows-test"));
          yield* TestClock.adjust(CuaDriver.IDLE_TIMEOUT);
          expect((yield* driver.status).status).toBe("running");
          expect(runs.some((r) => r.args[0] === "stop")).toBe(false);
        }),
      ),
  );
}

it.effect(
  "installs with PowerShell, opts out of telemetry, and registers then kicks the Scheduled Task",
  () =>
    withWindows({ installed: false, running: false }, ({ driver, runs }) =>
      Effect.gen(function* () {
        expect(yield* driver.status).toEqual({ status: "not-installed", platform: "win32" });
        expect((yield* driver.control({ action: "install" })).status).toBe("running");
        const installer = runs.find((r) => r.args.at(-1)?.includes("install.ps1"));
        expect(installer?.command).toBe("powershell.exe");
        expect(installer?.args).toEqual([
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "$ErrorActionPreference = 'Stop'; irm https://cua.ai/driver/install.ps1 | iex",
        ]);
        expect(installer?.env?.CUA_DRIVER_RS_TELEMETRY_ENABLED).toBe("false");
        expect(runs.filter((r) => r.args[0] === "autostart").map((r) => r.args)).toEqual([
          ["autostart", "enable"],
          ["autostart", "kick"],
        ]);
        expect(runs.some((r) => r.args.join(" ") === "telemetry disable")).toBe(true);
      }),
    ),
);

it.effect(
  "requires setup rather than starting a stray runtime when the desktop daemon is absent",
  () =>
    withWindows({ running: false }, ({ driver }) =>
      Effect.gen(function* () {
        expect(yield* driver.status).toMatchObject({
          status: "runtime-unavailable",
          detail: expect.stringContaining("Sign in to the Windows desktop"),
        });
        const error = yield* driver.catalog.pipe(Effect.flip);
        expect(error.detail).toContain("Session 0");
        expect(transports).toHaveLength(0);
        expect((yield* driver.control({ action: "start" })).status).toBe("running");
      }),
    ),
);

it.effect("fails closed when Windows checksums do not verify", () =>
  withWindows({ verified: false }, ({ driver, runs }) =>
    Effect.gen(function* () {
      expect(yield* driver.status).toEqual({ status: "untrusted" });
      yield* driver.catalog.pipe(Effect.flip);
      expect(runs.every((r) => r.command === "powershell.exe")).toBe(true);
      expect(transports).toHaveLength(0);
    }),
  ),
);

it.effect("reports Scheduled Task failures without opening a transport", () =>
  withWindows({ running: false, kickFails: true }, ({ driver }) =>
    Effect.gen(function* () {
      const error = yield* driver.control({ action: "start" }).pipe(Effect.flip);
      expect(error.detail).toContain("interactive desktop");
      expect(transports).toHaveLength(0);
    }),
  ),
);

it.effect(
  "verifies current Windows releases with Valid Authenticode and Cua's expected signer",
  () =>
    withWindows({ signedRelease: true }, ({ driver, runs }) =>
      Effect.gen(function* () {
        expect((yield* driver.status).status).toBe("running");
        const script = runs[0]?.args.at(-1);
        expect(script).toContain("Get-AuthenticodeSignature");
        expect(script).toContain("$signature.Status -ne 'Valid'");
        expect(script).toContain("Cua AI, Inc");
        expect(script).not.toContain("Invoke-WebRequest");
      }),
    ),
);

it.effect("refuses invalid Authenticode without executing the current Windows driver", () =>
  withWindows({ signedRelease: true, verified: false }, ({ driver, runs }) =>
    Effect.gen(function* () {
      expect(yield* driver.status).toEqual({ status: "untrusted" });
      expect(runs.every((r) => r.command === "powershell.exe")).toBe(true);
    }),
  ),
);

it("derives checksum URLs only from recognized installed release paths", () => {
  expect(windowsVerificationScript(String.raw`C:\untrusted\cua-driver.exe`)).toBeUndefined();
  expect(
    windowsVerificationScript(
      String.raw`C:\releases\0.21.0-aarch64-pc-windows-msvc\cua-driver.exe`,
    ),
  ).toContain("cua-driver-rs-0.21.0-windows-arm64-binary.zip");
});
