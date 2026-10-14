// @effect-diagnostics nodeBuiltinImport:off - Read-only bounded git snapshot selection.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { runPotetoCommand } from "./PotetoProjectRunner.ts";
import {
  validatePotetoDraft,
  type PotetoDraftRequest,
} from "../../provider/Layers/PiPotetoDraft.ts";
import type { PotetoDraftResult } from "@rove-code/contracts";

/** Pins HEAD once; reads only regular committed JS/TS blobs, never dirty files or symlinks. */
export async function selectPotetoDraftSnapshot(
  workspace: string,
  description: string,
  signal: AbortSignal,
) {
  let repositoryRoot = workspace;
  const git = async (args: string[], limit = 262_144) => {
    const output = await runPotetoCommand("git", ["--no-pager", ...args], {
      cwd: repositoryRoot,
      signal,
      timeoutMs: 10_000,
      maxOutputBytes: limit,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_COUNT: "0" },
    });
    if (output.code !== 0)
      throw new Error(
        "Committed source snapshot is unavailable; provide a committed JS/TS workspace.",
      );
    return output.stdout.toString("utf8");
  };
  // Projects may point at a package within a monorepo; scopes are always repo-relative.
  repositoryRoot = (await git(["rev-parse", "--show-toplevel"], 8192)).trim();
  const commit = (await git(["rev-parse", "--verify", "HEAD^{commit}"], 1024)).trim();
  // Path hints avoid listing a whole monorepo (including vendored references).
  const hints = [
    ...new Set(
      description.match(/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:[cm]?js|[cm]?ts|jsx|tsx)\b/g) ??
        [],
    ),
  ].slice(0, 16);
  const hintedTree =
    hints.length > 0 ? await git(["ls-tree", "-r", "-z", commit, "--", ...hints], 262_144) : "";
  const tree = hintedTree || (await git(["ls-tree", "-r", "-z", commit], 8_388_608));
  const sources = tree.split("\0").flatMap((entry) => {
    const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(entry);
    if (
      !match ||
      !/\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/.test(match[3]!) ||
      /[\\\0\t\r\n:,]/.test(match[3]!)
    )
      return [];
    return [{ oid: match[2]!, path: match[3]! }];
  });
  let selected = sources.filter((file) => description.includes(file.path));
  if (selected.length === 0 && sources.length <= 16) selected = sources;
  if (selected.length === 0) {
    const terms = [...new Set(description.match(/[A-Za-z_$][A-Za-z0-9_$]{3,}/g) ?? [])]
      .filter(
        (term) =>
          !/^(this|that|when|with|from|should|does|have|after|before|please|error|file|files|code|bug|doesn|work)$/i.test(
            term,
          ),
      )
      .slice(0, 12);
    if (terms.length > 0) {
      // Plain bug names often identify a module more precisely than ubiquitous source words.
      const named = sources.filter((file) => {
        const stem = NodePath.posix
          .basename(file.path)
          .replace(/\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/, "");
        return terms.some((term) => term.toLowerCase() === stem.toLowerCase());
      });
      if (named.length > 0) selected = named;
      else {
        const output = await runPotetoCommand(
          "git",
          [
            "--no-pager",
            "grep",
            "-l",
            "-z",
            "-I",
            "-F",
            ...terms.flatMap((term) => ["-e", term]),
            commit,
            "--",
            "*.js",
            "*.ts",
            "*.jsx",
            "*.tsx",
            "*.mjs",
            "*.mts",
            "*.cjs",
            "*.cts",
          ],
          { cwd: repositoryRoot, signal, timeoutMs: 10_000, maxOutputBytes: 65_536 },
        );
        if (output.code !== 0 && output.code !== 1)
          throw new Error("Unable to select committed context.");
        const paths = new Set(
          output.stdout
            .toString("utf8")
            .split("\0")
            .map((path) => (path.startsWith(`${commit}:`) ? path.slice(commit.length + 1) : path)),
        );
        selected = sources.filter((file) => paths.has(file.path));
      }
    }
  }
  if (selected.length === 0 || selected.length > 16)
    throw new Error(
      "Cannot meaningfully select a bounded source snapshot. Include explicit repo-relative JS/TS file paths in the description (at most 16), including the check module and required context.",
    );
  const files: { path: string; content: string }[] = [];
  let bytes = 0;
  for (const file of selected) {
    const content = await git(["cat-file", "blob", file.oid], 24_000);
    bytes += Buffer.byteLength(content);
    if (content.includes("\0") || bytes > 40_000)
      throw new Error(
        "Selected committed source is too large. Narrow the description to smaller explicit files.",
      );
    files.push({ path: file.path, content });
  }
  return files;
}

/** Neutral session directories avoid resource discovery in the actual project; always removed. */
export async function draftPotetoProject(options: {
  workspace: string;
  description: string;
  model: string;
  signal: AbortSignal;
  draft: (
    options: { cwd: string; agentDir: string; model: string },
    request: PotetoDraftRequest,
  ) => Promise<PotetoDraftResult>;
}): Promise<PotetoDraftResult> {
  let directory: string | undefined;
  try {
    const files = await selectPotetoDraftSnapshot(
      options.workspace,
      options.description,
      options.signal,
    );
    directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "rove-poteto-draft-"));
    const cwd = NodePath.join(directory, "worker");
    const agentDir = NodePath.join(directory, "agent");
    await NodeFSP.mkdir(cwd);
    await NodeFSP.mkdir(agentDir);
    return validatePotetoDraft(
      await options.draft(
        { cwd, agentDir, model: options.model },
        { description: options.description, files, signal: options.signal },
      ),
      files,
    );
  } catch (error) {
    options.signal.throwIfAborted();
    return {
      status: "unsupported",
      reason:
        (error instanceof Error ? error.message : "Unable to draft from this context.").slice(
          0,
          4096,
        ) || "Unable to draft.",
    };
  } finally {
    if (directory) await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}
