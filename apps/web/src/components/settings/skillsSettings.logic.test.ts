import { describe, expect, it } from "vite-plus/test";
import type { AgentSkillEntry, AgentSkillsStatus } from "@getpaperplane/contracts";

import {
  buildSkillMatrix,
  canSyncAgentSkills,
  filterSkillMatrixRows,
  gitStatusLabel,
} from "./skillsSettings.logic";

const skill = (name: string, contentHash: string, description?: string): AgentSkillEntry => {
  const base = { name, path: `/skills/${name}`, contentHash };
  return description === undefined ? base : { ...base, description };
};

describe("buildSkillMatrix", () => {
  it("marks a cell present when it matches the majority hash", () => {
    const rows = buildSkillMatrix([
      { environmentId: "a", skills: [skill("deploy", "h1")] },
      { environmentId: "b", skills: [skill("deploy", "h1")] },
      { environmentId: "c", skills: [skill("deploy", "h2")] },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cells).toEqual(["present", "present", "different"]);
    expect(rows[0]!.hasDifference).toBe(true);
  });

  it("breaks a tie on the hash held by the earliest environment", () => {
    const rows = buildSkillMatrix([
      { environmentId: "a", skills: [skill("deploy", "h2")] },
      { environmentId: "b", skills: [skill("deploy", "h1")] },
    ]);
    expect(rows[0]!.cells).toEqual(["present", "different"]);
  });

  it("reports a missing cell when an environment lacks the skill", () => {
    const rows = buildSkillMatrix([
      { environmentId: "a", skills: [skill("deploy", "h1")] },
      { environmentId: "b", skills: [] },
    ]);
    expect(rows[0]!.cells).toEqual(["present", "missing"]);
    expect(rows[0]!.hasDifference).toBe(true);
  });

  it("leaves cells unknown for environments whose skills are not loaded", () => {
    const rows = buildSkillMatrix([
      { environmentId: "a", skills: [skill("deploy", "h1")] },
      { environmentId: "offline", skills: null },
    ]);
    expect(rows[0]!.cells).toEqual(["present", null]);
    expect(rows[0]!.hasDifference).toBe(false);
  });

  it("sorts rows with differences first, then alphabetically", () => {
    const rows = buildSkillMatrix([
      {
        environmentId: "a",
        skills: [skill("zeta", "h1"), skill("alpha", "h1"), skill("beta", "h1")],
      },
      { environmentId: "b", skills: [skill("zeta", "h1"), skill("alpha", "h9")] },
    ]);
    // alpha differs on hash, beta is missing from b, zeta matches everywhere.
    expect(rows.map((row) => [row.name, row.hasDifference])).toEqual([
      ["alpha", true],
      ["beta", true],
      ["zeta", false],
    ]);
  });

  it("keeps the first description seen for a skill", () => {
    const rows = buildSkillMatrix([
      { environmentId: "a", skills: [skill("deploy", "h1", "Ship it")] },
      { environmentId: "b", skills: [skill("deploy", "h1")] },
    ]);
    expect(rows[0]!.description).toBe("Ship it");
  });
});

describe("filterSkillMatrixRows", () => {
  it("keeps only rows with differences when asked", () => {
    const rows = buildSkillMatrix([
      { environmentId: "a", skills: [skill("same", "h1"), skill("drift", "h1")] },
      { environmentId: "b", skills: [skill("same", "h1"), skill("drift", "h2")] },
    ]);
    expect(filterSkillMatrixRows(rows, true).map((row) => row.name)).toEqual(["drift"]);
    expect(filterSkillMatrixRows(rows, false)).toHaveLength(2);
  });
});

const status = (git: AgentSkillsStatus["git"]): AgentSkillsStatus => ({
  directory: "/home/me/.agents/skills",
  exists: true,
  skills: [],
  git,
});

const gitState = (overrides: Partial<NonNullable<AgentSkillsStatus["git"]>> = {}) => ({
  branch: "main",
  remoteUrl: "git@github.com:me/agent-skills.git",
  ahead: 0,
  behind: 0,
  dirty: false,
  diverged: false,
  lastFetchedAt: null,
  lastError: null,
  ...overrides,
});

describe("gitStatusLabel", () => {
  it("reports a folder that is not a repository", () => {
    expect(gitStatusLabel(status(null))).toEqual({
      text: "Not a git repository",
      tone: "neutral",
    });
  });

  it("reports up to date when nothing differs", () => {
    expect(gitStatusLabel(status(gitState()))).toEqual({ text: "Up to date", tone: "neutral" });
  });

  it("reports commits behind and ahead", () => {
    expect(gitStatusLabel(status(gitState({ behind: 3 })))).toEqual({
      text: "3 behind",
      tone: "warning",
    });
    expect(gitStatusLabel(status(gitState({ ahead: 2 })))).toEqual({
      text: "2 ahead",
      tone: "neutral",
    });
    expect(gitStatusLabel(status(gitState({ behind: 1, ahead: 2 })))).toEqual({
      text: "1 behind, 2 ahead",
      tone: "warning",
    });
  });

  it("reports uncommitted changes", () => {
    expect(gitStatusLabel(status(gitState({ dirty: true })))).toEqual({
      text: "Uncommitted changes",
      tone: "warning",
    });
  });

  it("names the directory to resolve a diverged history in, ahead of other states", () => {
    expect(gitStatusLabel(status(gitState({ diverged: true, dirty: true })))).toEqual({
      text: "Diverged — resolve in /home/me/.agents/skills",
      tone: "destructive",
    });
  });
});

describe("canSyncAgentSkills", () => {
  it("requires a remote and a history that has not forked", () => {
    expect(canSyncAgentSkills(status(gitState()))).toBe(true);
    expect(canSyncAgentSkills(status(gitState({ remoteUrl: null })))).toBe(false);
    expect(canSyncAgentSkills(status(gitState({ diverged: true })))).toBe(false);
    expect(canSyncAgentSkills(status(null))).toBe(false);
  });
});
