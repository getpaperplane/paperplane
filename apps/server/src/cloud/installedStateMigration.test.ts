import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@getpaperplane/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import { findOldService, retireOldService } from "./installedStateMigration.ts";

it.layer(NodeServices.layer)("old service conversion (fake service managers only)", (it) => {
  const harness = Effect.fn(function* (platform: "linux" | "darwin", contents: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "paperplane-service-migration-" });
    const filename = path.join(
      home,
      platform === "linux"
        ? ".config/systemd/user/rove.service"
        : "Library/LaunchAgents/io.github.hafiezul.rove.service.plist",
    );
    yield* fs.makeDirectory(path.dirname(filename), { recursive: true });
    yield* fs.writeFileString(filename, contents.replaceAll("<HOME>", home));
    const commands: string[] = [];
    const control = { fail: false };
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) => {
        commands.push(`${input.command} ${input.args.join(" ")}`);
        return Effect.succeed({
          code: ChildProcessSpawner.ExitCode(control.fail ? 1 : 0),
          stdout: "",
          stderr: "",
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        });
      },
    });
    const layer = Layer.mergeAll(
      Layer.succeed(HostProcess.Platform, platform),
      Layer.succeed(HostProcess.UserId, 501),
      Layer.succeed(ProcessRunner.ProcessRunner, runner),
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home } })),
    );
    return {
      fs,
      path,
      home,
      filename,
      commands,
      control,
      retire: retireOldService.pipe(Effect.provide(layer)),
      find: findOldService.pipe(Effect.provide(layer)),
    };
  });
  const unit =
    "[Service]\nExecStart=<HOME>/.rove-code/runtime/versions/1/rove __service-launcher\nEnvironment=ROVE_HOME=<HOME>/.rove-code\nEnvironment=ROVE_PORT=4777\nEnvironment=ROVE_HOST=0.0.0.0\nEnvironment=PATH=/custom/bin:/usr/bin\n";
  it.effect("retires an owned unit, preserves user settings, and does nothing on retry", () =>
    Effect.gen(function* () {
      const h = yield* harness("linux", unit);
      const sourceRuntime = h.path.join(h.home, ".rove-code/runtime");
      yield* h.fs.makeDirectory(sourceRuntime, { recursive: true });
      yield* h.fs.writeFileString(
        h.path.join(sourceRuntime, "service-config.json"),
        JSON.stringify({
          host: "localhost",
          port: 5555,
          tailscaleServeEnabled: true,
          tailscaleServePort: 8443,
        }),
      );
      expect((yield* h.find)?.ours).toBe(true);
      yield* h.retire;
      expect(yield* h.fs.exists(h.filename)).toBe(false);
      expect(h.commands).toEqual([
        "systemctl --user disable --now rove.service",
        "systemctl --user daemon-reload",
      ]);
      const config = JSON.parse(
        yield* h.fs.readFileString(h.path.join(h.home, ".paperplane/runtime/service-config.json")),
      );
      expect(config).toMatchObject({
        host: "0.0.0.0",
        port: 4777,
        environmentPath: "/custom/bin:/usr/bin",
        tailscaleServeEnabled: true,
        tailscaleServePort: 8443,
      });
      yield* h.retire;
      expect(h.commands).toHaveLength(2);
    }),
  );
  it.effect("never touches an unrelated unit even if its description mentions Rove", () =>
    Effect.gen(function* () {
      const h = yield* harness(
        "linux",
        "[Unit]\nDescription=Rove Code\n[Service]\nEnvironment=ROVE_HOME=<HOME>/.rove-code\nExecStart=/usr/bin/something-else serve\n",
      );
      expect((yield* h.find)?.ours).toBe(false);
      yield* h.retire;
      expect(h.commands).toEqual([]);
      expect(yield* h.fs.exists(h.filename)).toBe(true);
    }),
  );
  it.effect("keeps the old file when stopping fails", () =>
    Effect.gen(function* () {
      const h = yield* harness("linux", unit);
      h.control.fail = true;
      expect((yield* h.retire.pipe(Effect.flip))._tag).toBe("InstalledStateMigrationError");
      expect(yield* h.fs.exists(h.filename)).toBe(true);
    }),
  );
  it.effect("does not overwrite new settings or silently discard custom drop-ins", () =>
    Effect.gen(function* () {
      const h = yield* harness("linux", unit);
      yield* h.fs.makeDirectory(`${h.filename}.d`);
      expect((yield* h.retire.pipe(Effect.flip)).message).toContain("custom overrides");
      expect(h.commands).toEqual([]);
      yield* h.fs.remove(`${h.filename}.d`, { recursive: true });
      const target = h.path.join(h.home, ".paperplane/runtime");
      yield* h.fs.makeDirectory(target, { recursive: true });
      const contents = JSON.stringify({
        host: "127.0.0.1",
        port: 9000,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      });
      yield* h.fs.writeFileString(h.path.join(target, "service-config.json"), contents);
      yield* h.retire;
      expect(yield* h.fs.readFileString(h.path.join(target, "service-config.json"))).toBe(contents);
    }),
  );
  it.effect("retires an owned launch agent using its old label", () =>
    Effect.gen(function* () {
      const h = yield* harness(
        "darwin",
        "<dict><key>ProgramArguments</key><array><string><HOME>/.rove-code/runtime/versions/1/rove</string><string>__service-launcher</string></array><key>EnvironmentVariables</key><dict><key>ROVE_HOME</key><string><HOME>/.rove-code</string><key>ROVE_PORT</key><string>4777</string></dict></dict>",
      );
      yield* h.retire;
      expect(h.commands).toEqual([
        "launchctl print gui/501/io.github.hafiezul.rove.service",
        "launchctl bootout --wait gui/501/io.github.hafiezul.rove.service",
        "launchctl disable gui/501/io.github.hafiezul.rove.service",
      ]);
      expect(yield* h.fs.exists(h.filename)).toBe(false);
    }),
  );
});
