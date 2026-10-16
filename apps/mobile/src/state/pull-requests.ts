import {
  createPullRequestEnvironmentAtoms,
  createPullRequestStackAtomFamily,
} from "@rove-code/client-runtime/state/pull-requests";
import { connectionAtomRuntime } from "../connection/runtime";

export const composerPullRequests = createPullRequestEnvironmentAtoms(connectionAtomRuntime);
export const pullRequestStackAtom = createPullRequestStackAtomFamily(
  connectionAtomRuntime,
  composerPullRequests.refreshes,
);
