// @effect-diagnostics nodeBuiltinImport:off -- Real gh and git processes prove which credentials the agent commands actually use.
import { spawnSync } from "node:child_process";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { parse } from "yaml";

import * as ProcessRunner from "../processRunner.ts";
import * as AgentGitHubEnvironment from "./AgentGitHubEnvironment.ts";

const selection = { host: "github.com", login: "project-account" };
const fixtureHosts = `github.com:
  user: machine-account
  oauth_token: machine-token
  users:
    machine-account:
      oauth_token: machine-token
    project-account:
      oauth_token: project-token
    another-project:
      oauth_token: another-token
other.example.test:
  user: other-account
  oauth_token: other-host-token
`;

const liveLayer = AgentGitHubEnvironment.layer.pipe(
  Layer.provideMerge(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "paperplane-agent-gh-test-" });
  yield* fs.writeFileString(path.join(directory, "hosts.yml"), fixtureHosts);
  yield* fs.writeFileString(
    path.join(directory, "config.yml"),
    "aliases:\n  who: api user --jq .login\n",
  );
  return {
    fs,
    path,
    directory,
    environment: {
      ...process.env,
      GH_CONFIG_DIR: directory,
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      GH_ENTERPRISE_TOKEN: "",
      GITHUB_ENTERPRISE_TOKEN: "",
      GIT_CONFIG_COUNT: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
  };
});

const selectedTokenRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
  run: () =>
    Effect.succeed({
      stdout: "project-token\n",
      stderr: "",
      code: ChildProcessSpawner.ExitCode(0),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    }),
});
const nullAccountLayer = AgentGitHubEnvironment.layer.pipe(
  Layer.provideMerge(selectedTokenRunner),
  Layer.provideMerge(NodeServices.layer),
);

const hasCommands = ["gh", "git"].every(
  (command) => spawnSync(command, ["--version"]).status === 0,
);

describe("AgentGitHubEnvironment", () => {
  it.effect("leaves the environment untouched when no project account is selected", () =>
    Effect.gen(function* () {
      const service = yield* AgentGitHubEnvironment.AgentGitHubEnvironment;
      const environment = { GH_CONFIG_DIR: "/not-read", GIT_CONFIG_COUNT: "invalid" };
      assert.strictEqual(yield* service.prepare(null, environment), environment);
    }).pipe(Effect.scoped, Effect.provide(liveLayer)),
  );

  it.live.skipIf(!hasCommands)(
    "real gh and HTTPS git use the selected account, not the machine login",
    () =>
      Effect.gen(function* () {
        const { fs, path, directory, environment } = yield* fixture;
        const service = yield* AgentGitHubEnvironment.AgentGitHubEnvironment;
        const runner = yield* ProcessRunner.ProcessRunner;
        const configured = yield* service.prepare(selection, environment);
        const run = (command: string, args: string[], stdin?: string) =>
          runner.run({ command, args, env: configured, stdin });
        const gh = yield* run("gh", ["auth", "token", "--hostname", "github.com"]);
        assert.strictEqual(gh.code, 0);
        assert.strictEqual(gh.stdout.trim(), "project-token");
        const git = yield* run(
          "git",
          ["credential", "fill"],
          "protocol=https\nhost=github.com\n\n",
        );
        assert.strictEqual(git.code, 0);
        assert.include(git.stdout, "password=project-token");
        assert.notInclude(git.stdout, "machine-token");
        const other = yield* run("gh", ["auth", "token", "--hostname", "other.example.test"]);
        assert.strictEqual(other.stdout.trim(), "other-host-token");
        assert.strictEqual(
          (yield* run("gh", ["alias", "list"])).stdout.trim(),
          "who: api user --jq .login",
        );
        assert.strictEqual(
          yield* fs.readFileString(path.join(directory, "hosts.yml")),
          fixtureHosts,
        );
        assert.notStrictEqual(configured.GH_CONFIG_DIR, directory);
        assert.strictEqual((yield* fs.stat(configured.GH_CONFIG_DIR!)).mode & 0o777, 0o700);
        assert.strictEqual(
          (yield* fs.stat(path.join(configured.GH_CONFIG_DIR!, "hosts.yml"))).mode & 0o777,
          0o600,
        );
      }).pipe(Effect.scoped, Effect.provide(liveLayer)),
  );

  it.effect("repairs a null selected account without changing other account configuration", () =>
    Effect.gen(function* () {
      const { fs, path, directory, environment } = yield* fixture;
      const nullAccountHosts = fixtureHosts.replace(
        "    project-account:\n      oauth_token: project-token",
        "    project-account: null",
      );
      yield* fs.writeFileString(path.join(directory, "hosts.yml"), nullAccountHosts);
      const service = yield* AgentGitHubEnvironment.AgentGitHubEnvironment;
      const configured = yield* service.prepare(selection, environment);
      const hosts = parse(
        yield* fs.readFileString(path.join(configured.GH_CONFIG_DIR!, "hosts.yml")),
      );
      assert.deepStrictEqual(hosts["github.com"], {
        user: selection.login,
        oauth_token: "project-token",
        users: {
          "machine-account": { oauth_token: "machine-token" },
          "project-account": { oauth_token: "project-token" },
          "another-project": { oauth_token: "another-token" },
        },
      });
      assert.deepStrictEqual(hosts["other.example.test"], {
        user: "other-account",
        oauth_token: "other-host-token",
      });
      assert.deepStrictEqual(
        parse(yield* fs.readFileString(path.join(configured.GH_CONFIG_DIR!, "config.yml"))),
        { aliases: { who: "api user --jq .login" } },
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(directory, "hosts.yml")),
        nullAccountHosts,
      );
    }).pipe(Effect.scoped, Effect.provide(nullAccountLayer)),
  );

  it.effect("creates the users map when the host entry has a null users value", () =>
    Effect.gen(function* () {
      const { fs, path, directory, environment } = yield* fixture;
      yield* fs.writeFileString(
        path.join(directory, "hosts.yml"),
        "github.com:\n  user: machine-account\n  oauth_token: machine-token\n  users: null\n",
      );
      const service = yield* AgentGitHubEnvironment.AgentGitHubEnvironment;
      const configured = yield* service.prepare(selection, environment);
      const hosts = parse(
        yield* fs.readFileString(path.join(configured.GH_CONFIG_DIR!, "hosts.yml")),
      );
      assert.deepStrictEqual(hosts["github.com"], {
        user: selection.login,
        oauth_token: "project-token",
        users: { "project-account": { oauth_token: "project-token" } },
      });
      assert.strictEqual(
        yield* fs.readFileString(path.join(directory, "hosts.yml")),
        "github.com:\n  user: machine-account\n  oauth_token: machine-token\n  users: null\n",
      );
    }).pipe(Effect.scoped, Effect.provide(nullAccountLayer)),
  );

  it.live.skipIf(!hasCommands)(
    "concurrent project accounts stay isolated and credentials disappear when their session closes",
    () =>
      Effect.gen(function* () {
        const { fs, environment } = yield* fixture;
        const service = yield* AgentGitHubEnvironment.AgentGitHubEnvironment;
        const runner = yield* ProcessRunner.ProcessRunner;
        const directories = yield* Effect.scoped(
          Effect.gen(function* () {
            const first = yield* service.prepare(selection, environment);
            const second = yield* service.prepare(
              { host: "github.com", login: "another-project" },
              environment,
            );
            const read = (env: NodeJS.ProcessEnv) =>
              runner.run({
                command: "gh",
                args: ["auth", "token", "--hostname", "github.com"],
                env,
              });
            const outputs = yield* Effect.all([read(first), read(second), read(environment)], {
              concurrency: "unbounded",
            });
            assert.deepStrictEqual(
              outputs.map((output) => output.stdout.trim()),
              ["project-token", "another-token", "machine-token"],
            );
            return [first.GH_CONFIG_DIR!, second.GH_CONFIG_DIR!];
          }),
        );
        for (const directory of directories) assert.isFalse(yield* fs.exists(directory));
      }).pipe(Effect.scoped, Effect.provide(liveLayer)),
  );

  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
  ]) {
    it.live.skipIf(!hasCommands)(`respects explicit ${name} for both gh and git`, () =>
      Effect.gen(function* () {
        const { environment } = yield* fixture;
        const enterprise = name.includes("ENTERPRISE");
        const host = enterprise ? "enterprise.example.test" : "github.com";
        const service = yield* AgentGitHubEnvironment.AgentGitHubEnvironment;
        const runner = yield* ProcessRunner.ProcessRunner;
        const configured = yield* service.prepare(
          { host, login: "missing-account" },
          { ...environment, [name]: "deliberate-token" },
        );
        assert.strictEqual(configured.GH_CONFIG_DIR, environment.GH_CONFIG_DIR);
        const gh = yield* runner.run({
          command: "gh",
          args: ["auth", "token", "--hostname", host],
          env: configured,
        });
        const git = yield* runner.run({
          command: "git",
          args: ["credential", "fill"],
          stdin: `protocol=https\nhost=${host}\n\n`,
          env: configured,
        });
        assert.strictEqual(gh.stdout.trim(), "deliberate-token");
        assert.strictEqual(git.code, 0);
        assert.include(git.stdout, "password=deliberate-token");
      }).pipe(Effect.scoped, Effect.provide(liveLayer)),
    );
  }

  it.live.skipIf(!hasCommands)(
    "fails rather than silently falling back to the active account when the selection is unavailable",
    () =>
      Effect.gen(function* () {
        const { environment } = yield* fixture;
        const service = yield* AgentGitHubEnvironment.AgentGitHubEnvironment;
        const error = yield* Effect.flip(
          service.prepare({ host: "github.com", login: "missing-account" }, environment),
        );
        assert.strictEqual(error._tag, "AgentGitHubEnvironmentError");
        assert.strictEqual(error.stage, "credential");
        assert.notInclude(JSON.stringify(error), "machine-token");
      }).pipe(Effect.scoped, Effect.provide(liveLayer)),
  );

  it.live.skipIf(!hasCommands)(
    "preserves inherited git config and leaves other hosts' helpers alone",
    () =>
      Effect.gen(function* () {
        const { environment } = yield* fixture;
        const service = yield* AgentGitHubEnvironment.AgentGitHubEnvironment;
        const runner = yield* ProcessRunner.ProcessRunner;
        const configured = yield* service.prepare(selection, {
          ...environment,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "credential.https://unrelated.test.helper",
          GIT_CONFIG_VALUE_0: "!f() { echo username=unrelated; echo password=unrelated-token; }; f",
        });
        const other = yield* runner.run({
          command: "git",
          args: ["credential", "fill"],
          env: configured,
          stdin: "protocol=https\nhost=unrelated.test\n\n",
        });
        assert.strictEqual(other.code, 0);
        assert.include(other.stdout, "password=unrelated-token");
        assert.strictEqual(configured.GIT_CONFIG_COUNT, "3");
        assert.deepStrictEqual(
          parse(
            yield* (yield* FileSystem.FileSystem).readFileString(
              `${configured.GH_CONFIG_DIR}/hosts.yml`,
            ),
          )["github.com"].user,
          selection.login,
        );
      }).pipe(Effect.scoped, Effect.provide(liveLayer)),
  );
});
