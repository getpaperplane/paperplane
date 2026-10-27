// @effect-diagnostics nodeBuiltinImport:off - sha256 content hashing is synchronous and the
// hostname for commit messages has no Effect equivalent; both are pure node helpers.
/**
 * AgentSkills - the shared `~/.agents/skills` folder this environment manages.
 *
 * A user with several machines keeps one skills folder in git so each machine
 * can see whether it is behind and sync it. This service lists the skills,
 * reports git state, and performs init / fetch / fast-forward / commit / push.
 * Merges are never automatic: when local and remote both changed, the service
 * reports `diverged` and leaves resolution to the user.
 *
 * @module AgentSkills
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  type AgentSkillEntry,
  AgentSkillsError,
  type AgentSkillsGitStatus,
  type AgentSkillsStatus,
  type IsoDateTime,
} from "@getpaperplane/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import { parse as parseYamlDocument } from "yaml";

import * as ProcessRunner from "../processRunner.ts";

const SKILL_FILE = "SKILL.md";
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const GIT_TIMEOUT = Duration.seconds(30);
const BACKGROUND_FETCH_INTERVAL = Duration.minutes(30);
const DEFAULT_BRANCH = "main";
/** Used for commits only when git has no user identity configured. */
const FALLBACK_IDENTITY = ["-c", "user.name=Paperplane", "-c", "user.email=paperplane@localhost"];

export interface AgentSkillsOptions {
  /** Directory to manage. Defaults to `<home>/.agents/skills`. */
  readonly directory?: string;
  /** Background fetch interval. Pass `false` to disable it (tests). */
  readonly backgroundFetchInterval?: Duration.Input | false;
}

export class AgentSkills extends Context.Service<
  AgentSkills,
  {
    readonly getStatus: (input?: {
      readonly fetch?: boolean;
    }) => Effect.Effect<AgentSkillsStatus, AgentSkillsError>;
    readonly initRepository: (input?: {
      readonly remoteUrl?: string;
    }) => Effect.Effect<AgentSkillsStatus, AgentSkillsError>;
    readonly sync: () => Effect.Effect<AgentSkillsStatus, AgentSkillsError>;
  }
>()("@getpaperplane/server/agentSkills/AgentSkills") {}

interface FetchState {
  readonly lastFetchedAt: IsoDateTime | null;
  readonly lastError: string | null;
}

/**
 * Reads `name` and `description` from SKILL.md frontmatter. Retries once with
 * the same repair the provider skill loader applies to unquoted `: ` scalars.
 */
function parseSkillFrontmatter(contents: string): { name?: string; description?: string } {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return {};
  const frontmatter = match[1] ?? "";
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(frontmatter);
  } catch {
    const repaired = frontmatter.replace(
      /^([\w-]+:[ \t]*)([^\r\n]*)/gm,
      (line, prefix: string, value: string) => {
        const scalar = value.split(/[ \t]+#/)[0] ?? "";
        if (!/:[ \t]/.test(scalar) || /^(?:["'[\]{}|>&*!#%@`]|[-?:](?:[ \t]|$))/.test(scalar)) {
          return line;
        }
        return `${prefix}${JSON.stringify(scalar)}${value.slice(scalar.length)}`;
      },
    );
    try {
      parsed = parseYamlDocument(repaired);
    } catch {
      return {};
    }
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

const MAX_GIT_DETAIL_CHARS = 200;

/**
 * The first non-empty stderr line, trimmed and with URL credentials masked, so a
 * caller can tell auth failure from rejection without seeing a secret.
 */
export const redactGitDetail = (stderr: string): string | undefined => {
  const firstLine = stderr
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return undefined;
  return firstLine.replace(/\/\/[^/@\s]+@/g, "//***@").slice(0, MAX_GIT_DETAIL_CHARS);
};

const parseAheadBehind = (out: string): { ahead: number; behind: number } => {
  const [ahead, behind] = out.trim().split(/\s+/).map(Number);
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
};

const make = (options: AgentSkillsOptions = {}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const scope = yield* Scope.Scope;

    const directory = path.resolve(
      options.directory ?? path.join(NodeOS.homedir(), ".agents", "skills"),
    );
    const fetchState = yield* Ref.make<FetchState>({ lastFetchedAt: null, lastError: null });
    /** Serializes init and sync so two calls cannot race on the same index. */
    const mutex = yield* Semaphore.make(1);

    const fail = (operation: string, reason: string) => new AgentSkillsError({ operation, reason });

    // Runs git from an argv array (never a shell string). Prompting is disabled
    // so a credential request cannot hang the server.
    const runGit = (
      args: ReadonlyArray<string>,
      operation: string,
      gitOptions: { readonly fallbackIdentity?: boolean } = {},
    ) =>
      Effect.gen(function* () {
        const result = yield* processRunner
          .run({
            command: "git",
            args: [...(gitOptions.fallbackIdentity ? FALLBACK_IDENTITY : []), ...args],
            cwd: directory,
            timeout: GIT_TIMEOUT,
            env: { GIT_TERMINAL_PROMPT: "0" },
            outputMode: "truncate",
            timeoutBehavior: "timedOutResult",
          })
          .pipe(Effect.mapError(() => fail(operation, "git could not run")));
        if (result.timedOut) return yield* fail(operation, "git timed out");
        if (result.code !== 0) {
          const detail = redactGitDetail(result.stderr);
          return yield* fail(
            operation,
            detail ? `git command failed: ${detail}` : "git command failed",
          );
        }
        return result.stdout;
      });

    /** Whether git has a commit identity; when it does not, commits use the fallback. */
    const hasIdentity = runGit(["config", "user.email"], "identity").pipe(
      Effect.map((out) => out.trim().length > 0),
      Effect.orElseSucceed(() => false),
    );

    const commit = (message: string, operation: string) =>
      Effect.gen(function* () {
        const configured = yield* hasIdentity;
        yield* runGit(["commit", "-m", message], operation, {
          fallbackIdentity: !configured,
        });
      });

    const isRepository = Effect.gen(function* () {
      const exists = yield* fileSystem.exists(directory).pipe(Effect.orElseSucceed(() => false));
      if (!exists) return false;
      const topLevel = yield* runGit(["rev-parse", "--show-toplevel"], "status").pipe(
        Effect.map((out) => out.trim()),
        Effect.orElseSucceed(() => null),
      );
      if (topLevel === null) return false;
      const realDirectory = yield* fileSystem
        .realPath(directory)
        .pipe(Effect.orElseSucceed(() => directory));
      return path.resolve(topLevel) === path.resolve(realDirectory);
    });

    const listSkills = Effect.gen(function* () {
      const exists = yield* fileSystem.exists(directory).pipe(Effect.orElseSucceed(() => false));
      if (!exists) return { exists, skills: [] as AgentSkillEntry[] };
      const entries = yield* fileSystem
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed(() => [] as string[]));
      const skills: AgentSkillEntry[] = [];
      for (const entry of [...entries].toSorted()) {
        // Dot-directories (.git, .system, ...) are never skills.
        if (entry.startsWith(".")) continue;
        const skillDir = path.join(directory, entry);
        const contents = yield* fileSystem
          .readFileString(path.join(skillDir, SKILL_FILE))
          .pipe(Effect.orElseSucceed(() => null));
        if (contents === null) continue;
        const frontmatter = parseSkillFrontmatter(contents);
        skills.push({
          name: frontmatter.name ?? entry,
          ...(frontmatter.description ? { description: frontmatter.description } : {}),
          path: skillDir,
          contentHash: NodeCrypto.createHash("sha256").update(contents).digest("hex").slice(0, 16),
        });
      }
      return { exists, skills };
    });

    const fetchOrigin = Effect.gen(function* () {
      const now = yield* DateTime.now;
      const outcome = yield* runGit(["fetch", "--quiet", "origin"], "fetch").pipe(
        Effect.map(() => null as string | null),
        Effect.catchTag("AgentSkillsError", (error) => Effect.succeed(error.reason)),
      );
      if (outcome === null) {
        yield* Ref.set(fetchState, { lastFetchedAt: DateTime.formatIso(now), lastError: null });
      } else {
        yield* Ref.update(fetchState, (state) => ({ ...state, lastError: outcome }));
      }
    });

    const readGitStatus = (fetch: boolean) =>
      Effect.gen(function* () {
        const branch = yield* runGit(["rev-parse", "--abbrev-ref", "HEAD"], "status").pipe(
          Effect.map((out) => out.trim()),
          Effect.orElseSucceed(() => null),
        );
        const remoteUrl = yield* runGit(["remote", "get-url", "origin"], "status").pipe(
          Effect.map((out) => out.trim() || null),
          Effect.orElseSucceed(() => null),
        );
        if (fetch && remoteUrl !== null) yield* fetchOrigin;
        const porcelain = yield* runGit(["status", "--porcelain"], "status").pipe(
          Effect.orElseSucceed(() => ""),
        );
        const counts = yield* runGit(
          ["rev-list", "--left-right", "--count", "HEAD...@{u}"],
          "status",
        ).pipe(
          Effect.map(parseAheadBehind),
          Effect.orElseSucceed(() => ({ ahead: 0, behind: 0 })),
        );
        const state = yield* Ref.get(fetchState);
        const gitStatus: AgentSkillsGitStatus = {
          branch: branch === "HEAD" || branch === null ? null : branch,
          remoteUrl,
          ahead: counts.ahead,
          behind: counts.behind,
          dirty: porcelain.trim().length > 0,
          diverged: counts.ahead > 0 && counts.behind > 0,
          lastFetchedAt: state.lastFetchedAt,
          lastError: state.lastError,
        };
        return gitStatus;
      });

    const buildStatus = (fetch: boolean) =>
      Effect.gen(function* () {
        const { exists, skills } = yield* listSkills;
        const git = (yield* isRepository) ? yield* readGitStatus(fetch) : null;
        return { directory, exists, skills, git };
      });

    const hasRemote = Effect.gen(function* () {
      if (!(yield* isRepository)) return false;
      return yield* runGit(["remote", "get-url", "origin"], "sync").pipe(
        Effect.map((out) => out.trim().length > 0),
        Effect.orElseSucceed(() => false),
      );
    });

    const getStatus: AgentSkills["Service"]["getStatus"] = Effect.fn("AgentSkills.getStatus")(
      function* (input) {
        return yield* buildStatus(input?.fetch === true);
      },
    );

    const initRepository: AgentSkills["Service"]["initRepository"] = Effect.fn(
      "AgentSkills.initRepository",
    )(function* (input) {
      return yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          yield* fileSystem
            .makeDirectory(directory, { recursive: true })
            .pipe(Effect.mapError(() => fail("initRepository", "could not create the directory")));

          const created = !(yield* isRepository);
          if (created) {
            yield* runGit(["init", "-b", DEFAULT_BRANCH], "initRepository");
            yield* fileSystem
              .writeFileString(path.join(directory, ".gitignore"), ".DS_Store\n")
              .pipe(Effect.mapError(() => fail("initRepository", "could not write .gitignore")));
            yield* runGit(["add", "-A"], "initRepository");
            yield* commit("Initial skills", "initRepository");
          }

          if (input?.remoteUrl !== undefined) {
            const remoteUrl = input.remoteUrl;
            const current = yield* runGit(["remote", "get-url", "origin"], "initRepository").pipe(
              Effect.map((out) => out.trim()),
              Effect.orElseSucceed(() => null),
            );
            if (current === null) {
              yield* runGit(["remote", "add", "origin", remoteUrl], "initRepository");
            } else if (current !== remoteUrl) {
              yield* runGit(["remote", "set-url", "origin", remoteUrl], "initRepository");
            }
            const remoteHeads = yield* runGit(
              ["ls-remote", "--heads", "origin"],
              "initRepository",
            ).pipe(Effect.orElseSucceed(() => ""));
            const remoteHasMain = remoteHeads
              .split("\n")
              .some((line) => line.endsWith(`refs/heads/${DEFAULT_BRANCH}`));
            if (remoteHasMain) {
              yield* runGit(["fetch", "--quiet", "origin"], "initRepository");
              if (created) {
                // The machine's files were committed as "Initial skills" in a fresh
                // history. Joining the remote's history needs an unrelated-histories
                // merge; `-X theirs` lets the remote win on shared paths, while local-only
                // skills stay, and the machine's old versions remain in "Initial skills".
                yield* runGit(
                  [
                    "merge",
                    "--allow-unrelated-histories",
                    "--no-edit",
                    "-X",
                    "theirs",
                    `origin/${DEFAULT_BRANCH}`,
                  ],
                  "initRepository",
                );
              }
              yield* runGit(
                ["branch", "--set-upstream-to", `origin/${DEFAULT_BRANCH}`, DEFAULT_BRANCH],
                "initRepository",
              );
              const ahead = yield* runGit(
                ["rev-list", "--count", `origin/${DEFAULT_BRANCH}..HEAD`],
                "initRepository",
              ).pipe(Effect.map((out) => Number(out.trim()) || 0));
              if (ahead > 0) yield* runGit(["push", "-u", "origin", "HEAD"], "initRepository");
            } else {
              yield* runGit(["push", "-u", "origin", "HEAD"], "initRepository");
            }
          }
          return yield* buildStatus(false);
        }),
      );
    });

    const sync: AgentSkills["Service"]["sync"] = Effect.fn("AgentSkills.sync")(function* () {
      return yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          if (!(yield* hasRemote)) {
            return yield* fail("sync", "the skills folder is not a git repository with a remote");
          }
          const porcelain = yield* runGit(["status", "--porcelain"], "sync");
          if (porcelain.trim().length > 0) {
            yield* runGit(["add", "-A"], "sync");
            yield* commit(`Update skills from ${NodeOS.hostname()}`, "sync");
          }
          yield* runGit(["fetch", "--quiet", "origin"], "sync");

          const hasUpstream = yield* runGit(["rev-parse", "--abbrev-ref", "@{u}"], "sync").pipe(
            Effect.map(() => true),
            Effect.orElseSucceed(() => false),
          );
          const counts = hasUpstream
            ? yield* runGit(["rev-list", "--left-right", "--count", "HEAD...@{u}"], "sync").pipe(
                Effect.map(parseAheadBehind),
              )
            : { ahead: 0, behind: 0 };

          if (counts.ahead > 0 && counts.behind > 0) {
            // Report and stop: never merge or rebase skills on the user's behalf.
            yield* Ref.update(fetchState, (state) => ({
              ...state,
              lastError: `Local and remote both changed; resolve in ${directory}`,
            }));
            return yield* buildStatus(false);
          }
          if (counts.behind > 0) {
            yield* runGit(["merge", "--ff-only", "@{u}"], "sync");
          }
          if (counts.ahead > 0 || !hasUpstream) {
            yield* runGit(["push", "-u", "origin", "HEAD"], "sync");
          }
          yield* Ref.set(fetchState, {
            lastFetchedAt: DateTime.formatIso(yield* DateTime.now),
            lastError: null,
          });
          return yield* buildStatus(false);
        }),
      );
    });

    // Fetch-only background refresh so clients can show "behind" unprompted.
    // It never merges or pushes.
    if (options.backgroundFetchInterval !== false) {
      const interval = options.backgroundFetchInterval ?? BACKGROUND_FETCH_INTERVAL;
      yield* Effect.forkIn(
        Effect.gen(function* () {
          if (!(yield* isRepository) || !(yield* hasRemote)) return;
          yield* fetchOrigin;
        }).pipe(Effect.ignore, Effect.repeat(Schedule.spaced(interval)), Effect.ignore),
        scope,
      );
    }

    return AgentSkills.of({ getStatus, initRepository, sync });
  });

export const layer = (options?: AgentSkillsOptions) => Layer.effect(AgentSkills, make(options));
