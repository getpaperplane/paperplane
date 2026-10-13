import { describe, expect, it } from "vite-plus/test";

import { relayNeonBranchConfig } from "./dbConfig.ts";

describe("Neon relay database isolation", () => {
  it("uses the operator's existing production branch without creating a compute", () => {
    const config = relayNeonBranchConfig("prod", "project-123", "main");

    expect(config.project.projectId).toBe("project-123");
    expect(config.name).toBe("main");
    expect(config.parentBranch).toBeUndefined();
    expect(config.endpoints).toBeUndefined();
  });

  it("forks personal stages into separate branches with their migration history", () => {
    const production = relayNeonBranchConfig("prod", "project-123", "production");
    const alice = relayNeonBranchConfig("dev_alice", "project-123", "production");
    const bob = relayNeonBranchConfig("dev_bob", "project-123", "production");

    expect(new Set([production.name, alice.name, bob.name]).size).toBe(3);
    expect(alice.project).toEqual(production.project);
    expect(alice.parentBranch?.name).toBe(production.name);
    expect(bob.parentBranch?.name).toBe(production.name);
    expect(alice.initSource).toBe("parent-data");
    expect(bob.initSource).toBe("parent-data");
    expect(alice.endpoints?.[0]?.autoscalingLimitMaxCu).toBe(0.25);
  });

  it("keeps personal branches distinct even when production uses a stage-shaped name", () => {
    const production = relayNeonBranchConfig("prod", "project-123", "rove-relay-dev_alice");
    const personal = relayNeonBranchConfig("dev_alice", "project-123", production.name);

    expect(personal.name).not.toBe(production.name);
    expect(personal.parentBranch?.name).toBe(production.name);
  });
});
