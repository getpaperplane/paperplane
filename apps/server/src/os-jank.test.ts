import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@getpaperplane/shared/HostProcess";
import { CommandAvailability, WindowsShellEnvironment } from "@getpaperplane/shared/shell";
import * as Effect from "effect/Effect";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Observe the existing synchronous shell probe without launching the user's login shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Exercise migration before the server runtime opens its state.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Build only explicitly isolated temporary home paths.
import * as NodePath from "node:path";
import { assert, it, vi } from "vite-plus/test";

import { fixPath, hydratePosixHome, resolveBaseDir } from "./os-jank.ts";

vi.mock("node:child_process", { spy: true });

it.each(["runtime", "ssh-launch", "bin"])(
  "migrates the server default after %s was created",
  async (entry) => {
    const homeDirectory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "paperplane-server-home-"),
    );
    try {
      const oldState = NodePath.join(homeDirectory, ".rove-code", "userdata");
      NodeFS.mkdirSync(oldState, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(oldState, "settings.json"), '{"theme":"dark"}');
      const precreated = NodePath.join(homeDirectory, ".paperplane", entry);
      NodeFS.mkdirSync(precreated, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(precreated, "keep"), "new runtime or launch script");
      const baseDir = await Effect.runPromise(
        resolveBaseDir(undefined).pipe(
          Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
          Effect.provide(NodeServices.layer),
        ),
      );
      assert.equal(baseDir, NodePath.join(homeDirectory, ".paperplane"));
      assert.equal(
        NodeFS.readFileSync(NodePath.join(baseDir, "userdata", "settings.json"), "utf8"),
        '{"theme":"dark"}',
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(precreated, "keep"), "utf8"),
        "new runtime or launch script",
      );
    } finally {
      NodeFS.rmSync(homeDirectory, { recursive: true, force: true });
    }
  },
);

it("does not migrate for an explicit CLI home or disposable development state", async () => {
  const homeDirectory = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "paperplane-server-home-"),
  );
  try {
    NodeFS.mkdirSync(NodePath.join(homeDirectory, ".rove-code"));
    for (const effect of [
      resolveBaseDir(NodePath.join(homeDirectory, "custom")),
      resolveBaseDir(undefined, { development: true }),
    ]) {
      await Effect.runPromise(
        effect.pipe(
          Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
          Effect.provide(NodeServices.layer),
        ),
      );
    }
    assert.equal(NodeFS.existsSync(NodePath.join(homeDirectory, ".paperplane")), false);
  } finally {
    NodeFS.rmSync(homeDirectory, { recursive: true, force: true });
  }
});

it("hydrates HOME for minimal service environments from the user account", () => {
  const env: NodeJS.ProcessEnv = {};

  hydratePosixHome(env);

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("hydrates HOME independently of a blank process HOME", () => {
  const originalHome = process.env.HOME;
  const env: NodeJS.ProcessEnv = { HOME: " " };

  try {
    process.env.HOME = " ";
    hydratePosixHome(env);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("preserves an explicitly configured HOME", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };

  hydratePosixHome(env, () => {
    throw new Error("HOME lookup should not run");
  });

  assert.equal(env.HOME, "/custom/home");
});

effectIt.effect.each(["darwin", "linux"] as const)(
  "keeps the prepared PATH and still hydrates HOME on %s",
  (platform) =>
    Effect.acquireUseRelease(
      Effect.sync(() => vi.spyOn(NodeChildProcess, "execFileSync")),
      (probe) =>
        Effect.gen(function* () {
          probe.mockImplementation(() => {
            throw new Error("The prepared environment must not launch another shell");
          });
          const env: NodeJS.ProcessEnv = { PATH: "/prepared/bin:/usr/bin" };

          yield* fixPath({ shellEnvironmentPrepared: true }).pipe(
            Effect.provideService(HostProcess.Platform, platform),
            Effect.provideService(HostProcess.Environment, env),
            Effect.provide(NodeServices.layer),
          );

          assert.equal(probe.mock.calls.length, 0);
          assert.equal(env.PATH, "/prepared/bin:/usr/bin");
          assert.equal(env.HOME, NodeOS.userInfo().homedir);
        }),
      (probe) => Effect.sync(() => probe.mockRestore()),
    ),
);

effectIt.effect("hydrates PATH when the desktop handoff is absent", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue("__ROVE_ENV_PATH_START__\n/opt/tools/bin\n__ROVE_ENV_PATH_END__\n"),
    ),
    (probe) =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(probe.mock.calls.length, 1);
        assert.equal(env.PATH, "/opt/tools/bin:/usr/bin");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect("keeps mise's PATH record with the login shell PATH", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      vi
        .spyOn(NodeChildProcess, "execFileSync")
        .mockReturnValue(
          [
            "__ROVE_ENV_PATH_START__",
            "/home/me/.local/bin:/mise/installs/claude/latest:/mise/shims",
            "__ROVE_ENV_PATH_END__",
            "__ROVE_ENV___MISE_DIFF_START__",
            "mise-diff",
            "__ROVE_ENV___MISE_DIFF_END__",
          ].join("\n"),
        ),
    ),
    () =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin" };

        yield* fixPath().pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(NodeServices.layer),
        );

        assert.equal(env.__MISE_DIFF, "mise-diff");
      }),
    (probe) => Effect.sync(() => probe.mockRestore()),
  ),
);

effectIt.effect("keeps the prepared Windows PATH without probing", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { PATH: "C:\\Prepared\\Bin;C:\\Windows" };
    const commands: string[] = [];

    yield* fixPath({ shellEnvironmentPrepared: true }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(WindowsShellEnvironment, () => {
        throw new Error("The prepared environment must not launch another shell");
      }),
      Effect.provideService(CommandAvailability, (command) =>
        Effect.sync(() => {
          commands.push(command);
          return true;
        }),
      ),
      Effect.provide(NodeServices.layer),
    );

    assert.deepEqual(commands, []);
    assert.equal(env.PATH, "C:\\Prepared\\Bin;C:\\Windows");
  }),
);

effectIt.effect("replaces a Path-spelled Windows PATH instead of adding a second key", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Windows" };

    yield* fixPath().pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, env),
      Effect.provideService(WindowsShellEnvironment, () => ({ PATH: "C:\\Tools" })),
      Effect.provideService(CommandAvailability, () => Effect.succeed(true)),
      Effect.provide(NodeServices.layer),
    );

    assert.deepEqual(env, { PATH: "C:\\Tools;C:\\Windows" });
  }),
);
