import type { GitHubAccountSelection } from "@getpaperplane/contracts";
import * as HostProcess from "@getpaperplane/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { isMap, parseDocument, YAMLMap } from "yaml";

import * as ProcessRunner from "../processRunner.ts";

export class AgentGitHubEnvironmentError extends Schema.TaggedError<AgentGitHubEnvironmentError>()(
  "AgentGitHubEnvironmentError",
  {
    host: Schema.String,
    login: Schema.String,
    stage: Schema.Literals(["credential", "configuration"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not prepare the agent's GitHub account ${this.login} on ${this.host}. Check its sign-in or choose another account in Settings → Source Control.`;
  }
}

/** Session-owned credentials, never a change to the user's active gh login or git config. */
export class AgentGitHubEnvironment extends Context.Service<
  AgentGitHubEnvironment,
  {
    readonly prepare: (
      selection: GitHubAccountSelection | null,
      environment: NodeJS.ProcessEnv,
    ) => Effect.Effect<NodeJS.ProcessEnv, AgentGitHubEnvironmentError, Scope.Scope>;
  }
>()("@getpaperplane/server/provider/AgentGitHubEnvironment") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;

  const prepare = Effect.fn("AgentGitHubEnvironment.prepare")(function* (
    selection: GitHubAccountSelection | null,
    environment: NodeJS.ProcessEnv,
  ) {
    if (selection === null) return environment;
    const host = selection.host.trim().toLowerCase();
    const { login } = selection;
    // These values become a Git config key and gh YAML keys, not shell commands.
    if (!/^[a-z0-9.-]+(?::\d+)?$/i.test(host) || !/^[a-z0-9][a-z0-9._-]*$/i.test(login)) {
      return yield* new AgentGitHubEnvironmentError({ host, login, stage: "configuration" });
    }
    const tokenNames =
      host === "github.com" || host.endsWith(".ghe.com")
        ? ["GH_TOKEN", "GITHUB_TOKEN"]
        : ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
    const overridden = tokenNames.some((name) => Boolean(environment[name]?.trim()));
    let configured = environment;
    if (!overridden) {
      const result = yield* runner
        .run({
          command: "gh",
          args: ["auth", "token", "--hostname", host, "--user", login],
          env: { ...environment, GH_DEBUG: "", GH_PROMPT_DISABLED: "1" },
          timeout: "10 seconds",
          maxOutputBytes: 16 * 1024,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new AgentGitHubEnvironmentError({
                host,
                login,
                stage: "credential",
                cause,
              }),
          ),
        );
      if (result.code !== 0 || !result.stdout.trim()) {
        // Do not retain command output in an error: stdout contains a credential.
        return yield* new AgentGitHubEnvironmentError({ host, login, stage: "credential" });
      }
      const token = result.stdout.trim();
      const configuration = Effect.gen(function* () {
        const original =
          environment.GH_CONFIG_DIR ||
          (environment.XDG_CONFIG_HOME
            ? path.join(environment.XDG_CONFIG_HOME, "gh")
            : platform === "win32" && (environment.AppData || environment.APPDATA)
              ? path.join(environment.AppData || environment.APPDATA || "", "GitHub CLI")
              : path.join(environment.HOME || environment.USERPROFILE || home, ".config", "gh"));
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "paperplane-agent-gh-" });
        yield* fs.chmod(directory, 0o700);
        const readConfig = (name: string) =>
          fs
            .readFileString(path.join(original, name))
            .pipe(
              Effect.catch((error) =>
                error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
              ),
            );
        const source = yield* readConfig("hosts.yml");
        const document = yield* Effect.try(() => parseDocument(source));
        if (
          document.errors.length > 0 ||
          (document.contents !== null && !isMap(document.contents))
        ) {
          return yield* new AgentGitHubEnvironmentError({ host, login, stage: "configuration" });
        }
        yield* Effect.try(() => {
          if (!isMap(document.getIn([host, "users"]))) {
            document.setIn([host, "users"], new YAMLMap());
          }
          if (!isMap(document.getIn([host, "users", login]))) {
            document.setIn([host, "users", login], new YAMLMap());
          }
          document.setIn([host, "user"], login);
          document.setIn([host, "oauth_token"], token);
          document.setIn([host, "users", login, "oauth_token"], token);
        });
        yield* fs.writeFileString(path.join(directory, "hosts.yml"), document.toString(), {
          mode: 0o600,
        });
        yield* fs.writeFileString(
          path.join(directory, "config.yml"),
          yield* readConfig("config.yml"),
          { mode: 0o600 },
        );
        return { ...environment, GH_CONFIG_DIR: directory };
      }).pipe(
        Effect.mapError((cause) =>
          Schema.is(AgentGitHubEnvironmentError)(cause)
            ? cause
            : new AgentGitHubEnvironmentError({ host, login, stage: "configuration", cause }),
        ),
      );
      configured = yield* configuration;
    }
    // Reset helpers only for this HTTPS host; preserve unrelated hosts and inherited -c entries.
    // gh reads the session's host-scoped config, or the user's deliberate token override.
    const countKey =
      platform === "win32"
        ? (Object.keys(configured).find((key) => key.toUpperCase() === "GIT_CONFIG_COUNT") ??
          "GIT_CONFIG_COUNT")
        : "GIT_CONFIG_COUNT";
    const rawCount = configured[countKey] || "0";
    // Match Git's unsigned count parser, including leading whitespace and +0/-0.
    if (
      /^[ \t\r\n\v\f]*(?:\+?\d+|-0+)/.exec(rawCount)?.[0] !== rawCount ||
      !Number.isSafeInteger(Number(rawCount)) ||
      Number(rawCount) > Number.MAX_SAFE_INTEGER - 2
    ) {
      return yield* new AgentGitHubEnvironmentError({ host, login, stage: "configuration" });
    }
    const count = Number(rawCount);
    const key = `credential.https://${host}.helper`;
    return {
      ...configured,
      [countKey]: String(count + 2),
      [`GIT_CONFIG_KEY_${count}`]: key,
      [`GIT_CONFIG_VALUE_${count}`]: "",
      [`GIT_CONFIG_KEY_${count + 1}`]: key,
      [`GIT_CONFIG_VALUE_${count + 1}`]: "!gh auth git-credential",
    };
  });
  return AgentGitHubEnvironment.of({ prepare });
});

export const layer = Layer.effect(AgentGitHubEnvironment, make);
