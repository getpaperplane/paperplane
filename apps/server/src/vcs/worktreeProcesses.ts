import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { Platform as HostProcessPlatform } from "@rove-code/shared/HostProcess";

const WORKLOAD_POOL_SEGMENTS = [
  "/app-rove-workloads.slice/",
  // Older guarded commands can still be draining after an upgrade.
  "/rove-provider-workloads.slice/",
];
const TERMINATE_GRACE_MS = 3_000;
const EXIT_CHECK_INTERVAL_MS = 100;

/** The unified (v2) cgroup path from `/proc/<pid>/cgroup`, or undefined on v1-only hosts. */
function parseUnifiedCgroup(contents: string): string | undefined {
  for (const line of contents.split("\n")) {
    if (line.startsWith("0::")) return line.slice(3).trim();
  }
  return undefined;
}

/**
 * True when a process in `candidate` was started by this server: the server's
 * own cgroup subtree (agent tools, terminals, `nohup` descendants) or a
 * guarded provider workload scope.
 */
export function isServerOwnedCgroup(candidate: string, server: string): boolean {
  if (server === "/" || candidate === server || candidate.startsWith(`${server}/`)) return true;
  return WORKLOAD_POOL_SEGMENTS.some((segment) => candidate.includes(segment));
}

/** True when a `/proc/<pid>/cwd` link target sits inside one of `roots`, even after deletion. */
export function isCwdInside(cwdLink: string, roots: ReadonlyArray<string>): boolean {
  const cwd = cwdLink.endsWith(" (deleted)") ? cwdLink.slice(0, -" (deleted)".length) : cwdLink;
  return roots.some((root) => cwd === root || cwd.startsWith(`${root}/`));
}

function parseParentPid(stat: string): number | undefined {
  // The command name is parenthesized and may contain spaces or parentheses.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const parent = Number(fields[1]);
  return Number.isInteger(parent) && parent > 0 ? parent : undefined;
}

const signal = (pid: number, name: NodeJS.Signals | 0) =>
  Effect.sync(() => {
    try {
      process.kill(pid, name);
      return true;
    } catch {
      return false;
    }
  });

/**
 * Stops server-owned processes still running inside a removed worktree.
 *
 * Linux lets `git worktree remove` delete a checkout while processes keep it
 * as their working directory, so agent-launched dev servers and watchers
 * would otherwise survive indefinitely. Candidates are selected by cgroup
 * ownership plus working directory, never by name, and the server's own
 * process chain is excluded. Other platforms are a no-op: Windows refuses to
 * delete a busy directory, and macOS has no cheap ownership boundary.
 */
export const stopWorktreeProcesses = Effect.fn("stopWorktreeProcesses")(function* (
  roots: ReadonlyArray<string>,
) {
  const platform = yield* HostProcessPlatform;
  if (platform !== "linux" || roots.length === 0) return [];
  const fileSystem = yield* FileSystem.FileSystem;
  const read = (path: string) => fileSystem.readFileString(path).pipe(Effect.option);

  const serverCgroup = Option.flatMapNullishOr(
    yield* read("/proc/self/cgroup"),
    parseUnifiedCgroup,
  );
  if (Option.isNone(serverCgroup)) return [];

  const protectedPids = new Set<number>();
  for (let pid: number | undefined = process.pid; pid !== undefined && !protectedPids.has(pid);) {
    protectedPids.add(pid);
    pid = Option.getOrUndefined(
      Option.flatMapNullishOr(yield* read(`/proc/${pid}/stat`), parseParentPid),
    );
  }

  const entries = yield* fileSystem.readDirectory("/proc").pipe(Effect.orElseSucceed(() => []));
  const targets: Array<number> = [];
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 1 || protectedPids.has(pid)) continue;
    const cwd = yield* fileSystem.readLink(`/proc/${pid}/cwd`).pipe(Effect.option);
    if (Option.isNone(cwd) || !isCwdInside(cwd.value, roots)) continue;
    const cgroup = Option.flatMapNullishOr(yield* read(`/proc/${pid}/cgroup`), parseUnifiedCgroup);
    if (Option.isNone(cgroup) || !isServerOwnedCgroup(cgroup.value, serverCgroup.value)) continue;
    targets.push(pid);
  }
  if (targets.length === 0) return [];

  yield* Effect.forEach(targets, (pid) => signal(pid, "SIGTERM"), { discard: true });
  let alive = targets;
  for (let waited = 0; alive.length > 0 && waited < TERMINATE_GRACE_MS;) {
    yield* Effect.sleep(EXIT_CHECK_INTERVAL_MS);
    waited += EXIT_CHECK_INTERVAL_MS;
    alive = yield* Effect.filter(alive, (pid) => signal(pid, 0));
  }
  yield* Effect.forEach(alive, (pid) => signal(pid, "SIGKILL"), { discard: true });
  yield* Effect.logInfo(
    `Stopped ${targets.length} process(es) left running in a removed worktree` +
      (alive.length > 0 ? ` (${alive.length} force-killed).` : "."),
  );
  return targets;
});

/**
 * Roots to match for a removed worktree: the path as given plus its resolved
 * form (computed before removal, while symlinks still resolve), without
 * trailing separators. A filesystem root is never a worktree and is dropped so
 * a bad input can't widen the match to the whole machine.
 */
export function worktreeProcessRoots(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  const roots = new Set<string>();
  for (const path of paths) {
    const trimmed = path.replace(/[\\/]+$/, "");
    if (trimmed !== "" && !/^[A-Za-z]:$/.test(trimmed)) roots.add(trimmed);
  }
  return [...roots];
}

/**
 * Every worktree removal path calls this after Git has removed (or found
 * already gone) the checkout. It runs after, not before, because the cwd match
 * handles deleted directories and a removal Git refuses (dirty, locked) must
 * not have already killed the user's dev servers. Failures only log: the
 * checkout is gone by now, so failing the removal would misreport it.
 */
export const stopWorktreeProcessesAfterRemoval = Effect.fn("stopWorktreeProcessesAfterRemoval")(
  function* (worktreePath: string, resolvedPath?: string) {
    const roots = worktreeProcessRoots(
      resolvedPath === undefined ? [worktreePath] : [worktreePath, resolvedPath],
    );
    yield* stopWorktreeProcesses(roots).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not stop processes left in a removed worktree.", { cause }),
      ),
    );
  },
);
