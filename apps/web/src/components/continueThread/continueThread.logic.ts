import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  VcsStatusResult,
} from "@getpaperplane/contracts";

import type { ProviderInstanceEntry } from "../../providerInstances";

export interface ContinueTargetCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  /** The client's grant on that environment allows creating threads. */
  readonly canOperate: boolean;
}

export interface ContinueTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
}

/**
 * Environments a thread on `sourceEnvironmentId` can continue on. Offline ones
 * stay listed (disabled) so the user sees where the work could go; the list is
 * empty when no environment can take the work right now, which hides every
 * entry point.
 */
export function resolveContinueTargets(
  sourceEnvironmentId: EnvironmentId,
  candidates: ReadonlyArray<ContinueTargetCandidate>,
): ReadonlyArray<ContinueTarget> {
  const targets = candidates
    .filter((candidate) => candidate.environmentId !== sourceEnvironmentId && candidate.canOperate)
    .map(({ environmentId, label, connected }) => ({ environmentId, label, connected }))
    .toSorted((left, right) =>
      left.connected === right.connected
        ? left.label.localeCompare(right.label)
        : left.connected
          ? -1
          : 1,
    );
  return targets.some((target) => target.connected) ? targets : [];
}

export type ContinuePushPlan =
  | { readonly kind: "none" }
  | {
      readonly kind: "push";
      readonly action: "commit_push" | "push";
      /** Off on the default branch, where pushing straight to it deserves a deliberate opt-in. */
      readonly defaultOn: boolean;
      readonly summary: string;
    };

type PushStatus = Pick<
  VcsStatusResult,
  | "isRepo"
  | "hasPrimaryRemote"
  | "isDefaultRef"
  | "refName"
  | "hasWorkingTreeChanges"
  | "workingTree"
  | "hasUpstream"
  | "aheadCount"
>;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Whether the source checkout has work the target cannot fetch yet, and how to publish it. */
export function resolveContinuePushPlan(status: PushStatus | null): ContinuePushPlan {
  if (status === null || !status.isRepo || !status.hasPrimaryRemote || status.refName === null) {
    return { kind: "none" };
  }
  const branch = status.refName;
  const summary = status.hasWorkingTreeChanges
    ? `${plural(status.workingTree.files.length, "file")} changed on ${branch}, not pushed`
    : status.aheadCount > 0
      ? `${plural(status.aheadCount, "commit")} on ${branch} not pushed`
      : !status.hasUpstream
        ? `${branch} is not on the remote yet`
        : null;
  if (summary === null) return { kind: "none" };
  return {
    kind: "push",
    action: status.hasWorkingTreeChanges ? "commit_push" : "push",
    defaultOn: !status.isDefaultRef,
    summary,
  };
}

/** The first message the continued thread starts with; the transcript rides along as an attachment. */
export function buildContinuationPrompt(input: {
  readonly sourceLabel: string;
  readonly sourceTitle: string;
  readonly branch: string | null;
  /** The source's local changes were committed and pushed just before the handoff. */
  readonly pushedBeforeHandoff: boolean;
}): string {
  const intro = `Continue the work from the attached thread "${input.sourceTitle}", which ran on ${input.sourceLabel}. The attachment is its transcript; read it to see what was done and what is left.`;
  const checkout =
    input.branch === null
      ? "That thread had no branch. Check the state of this checkout (git status, git log) before changing anything."
      : `This checkout starts from origin/${input.branch}, the branch that thread worked on. Before changing anything, check its state (git status, git log) and confirm it matches where the transcript ends. When you push, push to ${input.branch} so both environments share it.`;
  const pushed =
    input.branch !== null && input.pushedBeforeHandoff
      ? `\n\nJust before this handoff, that thread's local changes were committed and pushed to ${input.branch}, so anything the transcript says is uncommitted is now in that branch.`
      : "";
  return `${intro}\n\n${checkout}${pushed}\n\nThen pick up where it left off.`;
}

interface ProjectLike {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly repositoryIdentity?: { readonly canonicalKey?: string | undefined } | null | undefined;
}

function repositoryKey(project: ProjectLike): string | null {
  return project.repositoryIdentity?.canonicalKey?.toLowerCase() ?? null;
}

/**
 * Suggests the target project. Repository identity only suggests; the user
 * confirms the choice in the dialog.
 */
export function suggestContinuationProject<P extends ProjectLike>(
  projects: ReadonlyArray<P>,
  targetEnvironmentId: EnvironmentId,
  sourceProject: ProjectLike | null,
) {
  const candidates = projects.filter((project) => project.environmentId === targetEnvironmentId);
  const sourceKey = sourceProject === null ? null : repositoryKey(sourceProject);
  const sameRepository =
    sourceKey === null
      ? undefined
      : candidates.find((project) => repositoryKey(project) === sourceKey);
  if (sameRepository) return { project: sameRepository, sameRepository: true };
  const sameTitle =
    sourceProject === null
      ? undefined
      : candidates.find((project) => project.title === sourceProject.title);
  return { project: sameTitle ?? candidates[0] ?? null, sameRepository: false };
}

/** Keeps the source thread's model when the target can run it, else the target's default. */
export function pickContinuationModel(
  source: ModelSelection | null,
  entries: ReadonlyArray<ProviderInstanceEntry>,
  targetDefault: ModelSelection | null,
): ModelSelection | null {
  if (
    source !== null &&
    entries.some(
      (entry) =>
        entry.instanceId === source.instanceId &&
        entry.enabled &&
        entry.installed &&
        entry.isAvailable &&
        entry.snapshot.auth.status !== "unauthenticated" &&
        entry.models.some((model) => model.slug === source.model && model.isLegacy !== true),
    )
  ) {
    return source;
  }
  return targetDefault;
}
