import {
  THREAD_CONTINUED_ACTIVITY_KIND,
  ThreadContinuationLink,
  type EnvironmentId,
  type OrchestrationThreadActivity,
  type ProjectId,
  type RepositoryIdentity,
} from "@rove-code/contracts";
import * as Schema from "effect/Schema";

/**
 * "Continue on another environment": the same repository checked out on
 * another machine picks a thread up from its pushed branch. Git carries the
 * code and the client carries the conversation, so the environments never
 * talk to each other.
 */

export interface HandoffTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly projectId: ProjectId;
  /** The target checkout's own name for the shared remote, e.g. `origin`. */
  readonly remoteName: string;
}

interface HandoffProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}

/**
 * Other environments that hold the same repository and can check out an
 * existing branch. One target per environment, the first matching project.
 */
export function resolveHandoffTargets(input: {
  readonly source: HandoffProject;
  readonly projects: ReadonlyArray<HandoffProject>;
  readonly environments: ReadonlyMap<
    EnvironmentId,
    {
      readonly label: string;
      readonly supportsCheckoutBaseBranch: boolean;
      readonly supportsPortableHandoff?: boolean;
    }
  >;
}): ReadonlyArray<HandoffTarget> {
  const canonicalKey = input.source.repositoryIdentity?.canonicalKey;
  if (!canonicalKey) return [];
  const targets = new Map<EnvironmentId, HandoffTarget>();
  for (const project of input.projects) {
    const identity = project.repositoryIdentity;
    if (
      project.environmentId === input.source.environmentId ||
      targets.has(project.environmentId) ||
      identity?.canonicalKey !== canonicalKey
    ) {
      continue;
    }
    const environment = input.environments.get(project.environmentId);
    if (!environment?.supportsCheckoutBaseBranch || environment.supportsPortableHandoff !== true)
      continue;
    targets.set(project.environmentId, {
      environmentId: project.environmentId,
      label: environment.label,
      projectId: project.id,
      remoteName: identity.locator.remoteName,
    });
  }
  return [...targets.values()].sort((left, right) => left.label.localeCompare(right.label));
}

export {
  selectHandoffItems,
  portableHandoffText,
  renderHandoffContext,
  readHandoffPage,
} from "@rove-code/shared/threadHandoff";

const isThreadContinuationLink = Schema.is(ThreadContinuationLink);

/** The most recent continuation recorded on a thread, newest activity last. */
export function resolveLatestContinuation(
  activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload">>,
): ThreadContinuationLink | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (
      activity.kind === THREAD_CONTINUED_ACTIVITY_KIND &&
      isThreadContinuationLink(activity.payload)
    ) {
      return activity.payload;
    }
  }
  return null;
}
