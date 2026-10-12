import { EnvironmentId, ProjectId, ThreadId } from "@rove-code/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveHandoffTargets, resolveLatestContinuation } from "./threadHandoff";

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");
const desk = EnvironmentId.make("desk");
function identity(canonicalKey: string, remoteName = "origin") {
  return {
    canonicalKey,
    locator: { source: "git-remote" as const, remoteName, remoteUrl: `git@x:${canonicalKey}` },
  };
}
const source = {
  id: ProjectId.make("p-laptop"),
  environmentId: laptop,
  repositoryIdentity: identity("github.com/acme/app"),
};
const projects = [
  source,
  {
    id: ProjectId.make("p-server"),
    environmentId: server,
    repositoryIdentity: identity("github.com/acme/app", "upstream"),
  },
  {
    id: ProjectId.make("p-server-dupe"),
    environmentId: server,
    repositoryIdentity: identity("github.com/acme/app"),
  },
  {
    id: ProjectId.make("p-desk"),
    environmentId: desk,
    repositoryIdentity: identity("github.com/acme/app"),
  },
  {
    id: ProjectId.make("p-other"),
    environmentId: server,
    repositoryIdentity: identity("github.com/acme/other"),
  },
];
const environments = new Map([
  [laptop, { label: "Laptop", supportsCheckoutBaseBranch: true, supportsPortableHandoff: true }],
  [server, { label: "Server", supportsCheckoutBaseBranch: true, supportsPortableHandoff: true }],
  [desk, { label: "Desk", supportsCheckoutBaseBranch: false, supportsPortableHandoff: true }],
]);

describe("resolveHandoffTargets", () => {
  it("lists one capable clone per other environment using its own remote name", () => {
    expect(resolveHandoffTargets({ source, projects, environments })).toEqual([
      {
        environmentId: server,
        label: "Server",
        projectId: ProjectId.make("p-server"),
        remoteName: "upstream",
      },
    ]);
  });
  it("offers nothing without a repository identity", () => {
    expect(
      resolveHandoffTargets({
        source: { ...source, repositoryIdentity: null },
        projects,
        environments,
      }),
    ).toEqual([]);
  });
  it("hides older hosts without verified portable handoff support", () => {
    const older = new Map([...environments]);
    older.set(server, {
      label: "Server",
      supportsCheckoutBaseBranch: true,
      supportsPortableHandoff: false,
    });
    expect(resolveHandoffTargets({ source, projects, environments: older })).toEqual([]);
    expect(
      resolveHandoffTargets({
        source,
        projects,
        environments: new Map([
          [server, { label: "Old server", supportsCheckoutBaseBranch: true }],
        ]),
      }),
    ).toEqual([]);
  });
});

describe("resolveLatestContinuation", () => {
  it("returns the newest valid lineage and ignores unrelated activities", () => {
    const older = {
      direction: "from" as const,
      environmentId: laptop,
      threadId: ThreadId.make("t-old"),
      environmentLabel: "Laptop",
    };
    const newer = {
      ...older,
      direction: "to" as const,
      threadId: ThreadId.make("t-new"),
      transferId: "transfer",
    };
    expect(
      resolveLatestContinuation([
        { kind: "thread.continued", payload: older },
        { kind: "thread.continued", payload: newer },
        { kind: "thread.handoff", payload: {} },
      ]),
    ).toEqual(newer);
    expect(resolveLatestContinuation([{ kind: "thread.continued", payload: {} }])).toBeNull();
  });
});
