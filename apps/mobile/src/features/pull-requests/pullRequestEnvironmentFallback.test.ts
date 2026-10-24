import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentProject } from "@getpaperplane/client-runtime/state/models";
import { pullRequestFallbackEnvironment } from "./pullRequestEnvironmentFallback";

const project = (environmentId: string, id: string, canonicalKey: string) =>
  ({
    environmentId,
    id,
    repositoryIdentity: { canonicalKey },
  }) as unknown as EnvironmentProject;

const projects = [
  project("laptop", "rove", "github.com/pingdotgg/t3code"),
  project("desktop", "other", "github.com/pingdotgg/other"),
  project("server", "rove-copy", "github.com/pingdotgg/t3code"),
];
const target = {
  environmentId: "laptop",
  projectId: "rove",
  repository: "pingdotgg/t3code",
  host: "github.com",
};

describe("pullRequestFallbackEnvironment", () => {
  it("moves to a connected copy of the repository when the original is down", () => {
    expect(
      pullRequestFallbackEnvironment(target, projects, new Set(["desktop", "server"])),
    ).toEqual({ environmentId: "server", projectId: "rove-copy" });
  });

  it("stays put while the original is connected or nothing else holds the repository", () => {
    expect(pullRequestFallbackEnvironment(target, projects, new Set(["laptop", "server"]))).toBe(
      null,
    );
    expect(pullRequestFallbackEnvironment(target, projects, new Set(["desktop"]))).toBe(null);
  });

  it("derives the host from the original project when the route has none", () => {
    const { host: _host, ...hostless } = target;
    expect(pullRequestFallbackEnvironment(hostless, projects, new Set(["server"]))).toEqual({
      environmentId: "server",
      projectId: "rove-copy",
    });
  });
});
