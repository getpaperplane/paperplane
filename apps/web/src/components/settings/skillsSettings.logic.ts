import type { AgentSkillEntry, AgentSkillsStatus } from "@getpaperplane/contracts";

export type SkillCellState = "present" | "different" | "missing";

export interface SkillMatrixEnvironment {
  readonly environmentId: string;
  /** Null while the environment is not loaded (disconnected, loading, or errored). */
  readonly skills: ReadonlyArray<AgentSkillEntry> | null;
}

export interface SkillMatrixRow {
  readonly name: string;
  readonly description: string | undefined;
  /** Parallel to the environments passed in, so cells line up with column headers. */
  readonly cells: ReadonlyArray<SkillCellState | null>;
  readonly hasDifference: boolean;
}

/**
 * The hash most environments agree on for one skill. A tie goes to the hash
 * held by the earliest environment in `environments`, so the result is stable
 * across renders.
 */
function majorityHash(
  environments: ReadonlyArray<SkillMatrixEnvironment>,
  name: string,
): string | null {
  const counts = new Map<string, number>();
  const firstIndex = new Map<string, number>();
  environments.forEach((environment, index) => {
    const entry = environment.skills?.find((skill) => skill.name === name);
    if (!entry) return;
    counts.set(entry.contentHash, (counts.get(entry.contentHash) ?? 0) + 1);
    if (!firstIndex.has(entry.contentHash)) firstIndex.set(entry.contentHash, index);
  });
  let best: string | null = null;
  for (const [hash, count] of counts) {
    if (best === null) {
      best = hash;
      continue;
    }
    const bestCount = counts.get(best) ?? 0;
    if (
      count > bestCount ||
      (count === bestCount && firstIndex.get(hash)! < firstIndex.get(best)!)
    ) {
      best = hash;
    }
  }
  return best;
}

/**
 * Builds the skill x environment matrix. Environments whose skills are not
 * loaded yield `null` cells rather than `missing`, so an offline machine is
 * not reported as lacking every skill.
 */
export function buildSkillMatrix(
  environments: ReadonlyArray<SkillMatrixEnvironment>,
): ReadonlyArray<SkillMatrixRow> {
  const loaded = environments.filter((environment) => environment.skills !== null);
  const descriptions = new Map<string, string | undefined>();
  for (const environment of loaded) {
    for (const skill of environment.skills ?? []) {
      if (!descriptions.has(skill.name) || descriptions.get(skill.name) === undefined) {
        descriptions.set(skill.name, skill.description);
      }
    }
  }
  const rows = [...descriptions.keys()].map((name) => {
    const majority = majorityHash(environments, name);
    const cells = environments.map((environment): SkillCellState | null => {
      if (environment.skills === null) return null;
      const entry = environment.skills.find((skill) => skill.name === name);
      if (!entry) return "missing";
      return entry.contentHash === majority ? "present" : "different";
    });
    return {
      name,
      description: descriptions.get(name),
      cells,
      hasDifference: cells.some((cell) => cell === "missing" || cell === "different"),
    };
  });
  return rows.toSorted((left, right) => {
    if (left.hasDifference !== right.hasDifference) return left.hasDifference ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

export type GitStatusTone = "neutral" | "warning" | "destructive";

export interface GitStatusLabel {
  readonly text: string;
  readonly tone: GitStatusTone;
}

/**
 * One line summarizing the repository. The most actionable state wins: a
 * repository that cannot sync is reported before one that merely lags.
 */
export function gitStatusLabel(status: AgentSkillsStatus): GitStatusLabel {
  const git = status.git;
  if (git === null) return { text: "Not a git repository", tone: "neutral" };
  if (git.diverged) {
    return { text: `Diverged — resolve in ${status.directory}`, tone: "destructive" };
  }
  if (git.dirty) return { text: "Uncommitted changes", tone: "warning" };
  if (git.behind > 0 && git.ahead > 0) {
    return { text: `${git.behind} behind, ${git.ahead} ahead`, tone: "warning" };
  }
  if (git.behind > 0) return { text: `${git.behind} behind`, tone: "warning" };
  if (git.ahead > 0) return { text: `${git.ahead} ahead`, tone: "neutral" };
  return { text: "Up to date", tone: "neutral" };
}

/** Sync needs a remote, and cannot run while the history has forked. */
export function canSyncAgentSkills(status: AgentSkillsStatus): boolean {
  const git = status.git;
  return git !== null && git.remoteUrl !== null && !git.diverged;
}

/** Keeps only rows where some environment is missing the skill or disagrees on it. */
export function filterSkillMatrixRows(
  rows: ReadonlyArray<SkillMatrixRow>,
  onlyDifferences: boolean,
): ReadonlyArray<SkillMatrixRow> {
  return onlyDifferences ? rows.filter((row) => row.hasDifference) : rows;
}
