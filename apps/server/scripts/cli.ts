#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { DEVELOPMENT_ICON_OVERRIDES } from "../../../scripts/lib/brand-assets.ts";
import { findEsmImportsOfExternalPackages } from "../../../scripts/lib/cli-executable-imports.ts";
import { resolveSpawnCommand } from "@getpaperplane/shared/shell";
import {
  ServerCliBuildAssetMissingError,
  ServerCliCommandExitError,
  ServerCliDevelopmentIconSourceMissingError,
  ServerCliDevelopmentIconTargetMissingError,
  ServerCliExecutableImportError,
  ServerCliRegistryWaitError,
} from "./cliErrors.ts";

import { publishPlatformsThenLauncher } from "./publishOrder.ts";

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.StandardCommand) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new ServerCliCommandExitError({
      command: command.command,
      args: command.args,
      cwd: command.options.cwd,
      exitCode,
    });
  }
});

const applyDevelopmentIconOverrides = Effect.fn("applyDevelopmentIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const override of DEVELOPMENT_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new ServerCliDevelopmentIconSourceMissingError({ sourcePath });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new ServerCliDevelopmentIconTargetMissingError({ targetPath });
    }

    yield* fs.copyFile(sourcePath, targetPath);
  }

  yield* Effect.log("[cli] Applied development icon overrides to dist/client");
});

// ---------------------------------------------------------------------------
// build subcommand
// ---------------------------------------------------------------------------

const buildCmd = Command.make(
  "build",
  {
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Running tsdown...");
      yield* runCommand(
        ChildProcess.make(process.execPath, ["--run", "build:bundle"], {
          cwd: serverDir,
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: false,
        }),
      );

      const webDist = path.join(repoRoot, "apps/web/dist");
      const clientTarget = path.join(serverDir, "dist/client");

      if (yield* fs.exists(webDist)) {
        yield* fs.copy(webDist, clientTarget);
        yield* applyDevelopmentIconOverrides(repoRoot, serverDir);
        yield* Effect.log("[cli] Bundled web app into dist/client");
      } else {
        yield* Effect.logWarning("[cli] Web dist not found — skipping client bundle.");
      }
    }),
).pipe(Command.withDescription("Build the server package (tsdown + bundle web client)."));

// ---------------------------------------------------------------------------
// build-exe subcommand
// ---------------------------------------------------------------------------

const buildExeCmd = Command.make(
  "build-exe",
  {
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
    target: Flag.String("target").pipe(
      Flag.withDescription(
        "Cross-build for <platform>-<arch> in nodejs.org naming (for example darwin-x64); defaults to the host.",
      ),
      Flag.optional,
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Building single-executable...");
      const spawnCommand = yield* resolveSpawnCommand("vp", ["pack"]);
      yield* runCommand(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: serverDir,
          env: {
            ...process.env,
            PAPERPLANE_PACK_EXE: "1",
            ...Option.match(config.target, {
              onNone: () => ({}),
              onSome: (target) => ({ PAPERPLANE_PACK_EXE_TARGET: target }),
            }),
          },
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: spawnCommand.shell,
        }),
      );

      // The executable can only `import` built-ins. A file-backed import
      // passes the bundler and `node dist/bin.mjs`, then throws inside the
      // binary, so read the emitted module graph rather than trusting config.
      const bundlePath = path.join(serverDir, "dist-exe/bin.mjs");
      const specifiers = findEsmImportsOfExternalPackages(yield* fs.readFileString(bundlePath));
      if (specifiers.length > 0) {
        return yield* new ServerCliExecutableImportError({ bundlePath, specifiers });
      }
      yield* Effect.log(
        "[cli] Built dist-exe/paperplane (expects client/, resource-monitor/, and the runtime-external node_modules beside it; scripts/build-cli-archive.ts assembles that tree)",
      );
    }),
).pipe(
  Command.withDescription(
    "Build the server as a Node single-executable (needs a Node 25.7+ host for --build-sea). The binary still resolves native packages from a node_modules tree beside it.",
  ),
);

// ---------------------------------------------------------------------------
// publish subcommand
// ---------------------------------------------------------------------------

// npm accepts a large tarball long before it serves it: Linux packages have
// taken over an hour to appear. Until then npm silently skips the missing
// optional dependency and the launcher installs without an executable.
const REGISTRY_WAIT_MINUTES = 120;
const REGISTRY_POLL_SECONDS = 15;
const decodePackageManifest = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String, version: Schema.String })),
);

/** Whether the configured registry serves `spec` (`name@version`) right now. */
const registryServes = Effect.fn("registryServes")(function* (spec: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const spawnCommand = yield* resolveSpawnCommand("npm", [
    "view",
    spec,
    "version",
    "--prefer-online",
  ]);
  const child = yield* spawner.spawn(
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      stdout: "ignore",
      stderr: "ignore",
      shell: spawnCommand.shell,
    }),
  );
  return (yield* child.exitCode) === 0;
});

/**
 * Publishes the tarballs scripts/build-npm-platform-packages.ts produced:
 * every `@getpaperplane/cli-<platform>.tgz` first, `@getpaperplane/cli.tgz` (the launcher) last, so
 * the launcher is never installable before the executables it depends on.
 * Tarballs rather than directories because `npm publish <dir>` strips the
 * `node_modules/` the executable loads its native addons from.
 *
 * A real publish waits until npm serves every platform package before
 * publishing the launcher, and skips versions npm already serves so a timed-out
 * run can be retried.
 */
const publishCmd = Command.make(
  "publish",
  {
    packagesDir: Flag.String("packages-dir").pipe(
      Flag.withDescription("Output dir of scripts/build-npm-platform-packages.ts."),
    ),
    only: Flag.Literals("only", ["platforms", "launcher", "both"]).pipe(
      Flag.withDefault("both"),
      Flag.withDescription(
        "Publish platforms early, or wait for them and publish only the launcher.",
      ),
    ),
    tag: Flag.String("tag").pipe(Flag.withDefault("latest")),
    access: Flag.String("access").pipe(Flag.withDefault("public")),
    provenance: Flag.Boolean("provenance").pipe(Flag.withDefault(false)),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      // npm runs with cwd set to the packages dir below, so tarball paths are
      // resolved once here rather than joined twice.
      const packagesDir = path.resolve(config.packagesDir);
      const scopeDir = path.join(packagesDir, "@getpaperplane");
      const launcherTarball = path.join(scopeDir, "cli.tgz");
      const platformTarballs = (yield* fs
        .readDirectory(scopeDir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])))
        .filter((entry) => entry.startsWith("cli-") && entry.endsWith(".tgz"))
        .sort()
        .map((entry) => path.join(scopeDir, entry));
      if (platformTarballs.length === 0) {
        return yield* new ServerCliBuildAssetMissingError({
          assetPath: path.join(scopeDir, "cli-<platform>.tgz"),
        });
      }
      if (config.only !== "platforms" && !(yield* fs.exists(launcherTarball))) {
        return yield* new ServerCliBuildAssetMissingError({ assetPath: launcherTarball });
      }

      const args = ["publish", "--access", config.access, "--tag", config.tag];
      if (config.provenance) args.push("--provenance");
      if (config.dryRun) args.push("--dry-run");

      // Each tarball sits beside the package directory it was packed from.
      const specOf = Effect.fn("specOf")(function* (tarball: string) {
        const manifest = yield* decodePackageManifest(
          yield* fs.readFileString(path.join(tarball.replace(/\.tgz$/, ""), "package.json")),
        );
        return `${manifest.name}@${manifest.version}`;
      });

      const publishTarball = Effect.fn("publishTarball")(function* (tarball: string) {
        if (!config.dryRun) {
          const spec = yield* specOf(tarball);
          if (yield* registryServes(spec)) {
            yield* Effect.log(`[cli] ${spec} is already on npm; skipping`);
            return;
          }
        }
        const spawnCommand = yield* resolveSpawnCommand("npm", [...args, tarball]);
        yield* Effect.log(`[cli] npm ${args.join(" ")} ${path.basename(tarball)}`);
        yield* runCommand(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: packagesDir,
            stdout: config.verbose ? "inherit" : "ignore",
            stderr: "inherit",
            shell: spawnCommand.shell,
          }),
        );
      });

      const waitForPlatforms = Effect.gen(function* () {
        if (config.dryRun) return;
        let waiting = yield* Effect.forEach(platformTarballs, specOf);
        const deadline = (yield* Clock.currentTimeMillis) + REGISTRY_WAIT_MINUTES * 60_000;
        while (true) {
          const served = yield* Effect.forEach(waiting, registryServes, {
            concurrency: "unbounded",
          });
          waiting = waiting.filter((_, index) => !served[index]);
          if (waiting.length === 0) break;
          if ((yield* Clock.currentTimeMillis) >= deadline) {
            return yield* new ServerCliRegistryWaitError({
              packages: waiting,
              minutes: REGISTRY_WAIT_MINUTES,
            });
          }
          yield* Effect.log(`[cli] Waiting for npm to serve ${waiting.join(", ")}`);
          yield* Effect.sleep(`${REGISTRY_POLL_SECONDS} seconds`);
        }
      });
      yield* publishPlatformsThenLauncher({
        platformTarballs,
        launcherTarball,
        publish: publishTarball,
        only: config.only,
        waitForPlatforms,
      });
    }),
).pipe(
  Command.withDescription(
    "Publish the @getpaperplane/cli-<platform> tarballs and then @getpaperplane/cli to npm.",
  ),
);

// ---------------------------------------------------------------------------
// root command
// ---------------------------------------------------------------------------

const cli = Command.make("cli").pipe(
  Command.withDescription("Paperplane server build & publish CLI."),
  Command.withSubcommands([buildCmd, buildExeCmd, publishCmd]),
);

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
  NodeRuntime.runMain,
);
