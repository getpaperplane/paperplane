/**
 * ClaudeSharedSkillsBridge — lets Claude Code see the cross-provider skills
 * folder `~/.agents/skills`.
 *
 * Claude Code only reads skills from `<CLAUDE_CONFIG_DIR>/skills` and
 * `<cwd>/.claude/skills`, but Pi, Codex, Cursor, Antigravity and OpenCode all
 * read `~/.agents/skills`. Verified against the CLI: a directory passed via
 * `--add-dir` contributes its `.claude/skills`, and that works when the
 * `.claude/skills` entry is a symlink. So Paperplane keeps a small bridge
 * directory under its state dir whose `.claude/skills` links to
 * `~/.agents/skills`, and the adapter adds the bridge to the Claude query's
 * `additionalDirectories`.
 *
 * @module provider/Drivers/ClaudeSharedSkillsBridge
 */

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

/** Directory name, under the Paperplane state dir, that holds the bridge. */
const BRIDGE_DIRECTORY_NAME = "claude-shared-skills";

/**
 * Ensure the bridge exists and points at `<home>/.agents/skills`, returning
 * the bridge directory to add as an additional directory. Returns `undefined`
 * (no bridge) when the shared folder is absent, when the user's own Claude
 * skills directory already resolves to the shared folder, or on any filesystem
 * error. Best-effort by design: a failed bridge must never block a turn.
 */
export const ensureClaudeSharedSkillsBridge = Effect.fn("ensureClaudeSharedSkillsBridge")(
  function* (input: {
    readonly stateDir: string;
    readonly home: string;
    readonly claudeConfigDir: string;
  }): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const sharedSkills = path.join(input.home, ".agents", "skills");
    const isSharedDirectory = yield* fileSystem.stat(sharedSkills).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
    if (!isSharedDirectory) {
      return undefined;
    }

    const sharedRealPath = yield* fileSystem
      .realPath(sharedSkills)
      .pipe(Effect.orElseSucceed(() => undefined));
    // The user already points Claude Code at the shared folder; bridging it
    // again would only duplicate every skill.
    const userSkillsRealPath = yield* fileSystem
      .realPath(path.join(input.claudeConfigDir, "skills"))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (sharedRealPath !== undefined && sharedRealPath === userSkillsRealPath) {
      return undefined;
    }

    const bridgeDir = path.join(input.stateDir, BRIDGE_DIRECTORY_NAME);
    const linkPath = path.join(bridgeDir, ".claude", "skills");
    const linked = yield* ensureSymlink(linkPath, sharedSkills).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.logDebug("claude shared skills bridge unavailable; skipping", {
          bridgeDir,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );
    return linked ? bridgeDir : undefined;
  },
);

/**
 * Make `linkPath` a symlink to `target`, replacing a stale link that points
 * elsewhere and leaving an already-correct link untouched (idempotent).
 */
const ensureSymlink = Effect.fn("ensureSymlink")(function* (
  linkPath: string,
  target: string,
): Effect.fn.Return<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(linkPath), { recursive: true });

  // readLink fails for anything that is not a symlink, including a missing
  // path. Only a symlink (or nothing) is replaced; a real directory here is
  // not ours to delete, so the error surfaces and the bridge is skipped.
  const existing = yield* fileSystem.readLink(linkPath).pipe(Effect.orElseSucceed(() => undefined));
  if (existing === target) {
    return;
  }
  if (existing !== undefined) {
    yield* fileSystem.remove(linkPath);
  }
  yield* fileSystem.symlink(target, linkPath);
});
