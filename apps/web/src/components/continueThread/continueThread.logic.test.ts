import { EnvironmentId, ProjectId, ProviderInstanceId } from "@getpaperplane/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { buildThreadActionMenuItems, threadActionRequiresOperate } from "../threadActionMenu.logic";
import {
  buildContinuationPrompt,
  pickContinuationModel,
  resolveContinuePushPlan,
  resolveContinueTargets,
  suggestContinuationProject,
} from "./continueThread.logic";

const work = EnvironmentId.make("work");
const personal = EnvironmentId.make("personal");
const laptop = EnvironmentId.make("laptop");

describe("resolveContinueTargets", () => {
  it("drops the source and environments without operate, listing connected ones first", () => {
    expect(
      resolveContinueTargets(personal, [
        { environmentId: personal, label: "Personal", connected: true, canOperate: true },
        { environmentId: laptop, label: "Laptop", connected: false, canOperate: true },
        { environmentId: work, label: "Work", connected: true, canOperate: true },
        {
          environmentId: EnvironmentId.make("ro"),
          label: "Viewer",
          connected: true,
          canOperate: false,
        },
      ]),
    ).toEqual([
      { environmentId: work, label: "Work", connected: true },
      { environmentId: laptop, label: "Laptop", connected: false },
    ]);
  });

  it("is empty when no other environment can take the work now", () => {
    expect(
      resolveContinueTargets(personal, [
        { environmentId: personal, label: "Personal", connected: true, canOperate: true },
        { environmentId: laptop, label: "Laptop", connected: false, canOperate: true },
        { environmentId: work, label: "Work", connected: true, canOperate: false },
      ]),
    ).toEqual([]);
  });
});

const cleanStatus = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feat/csv-export",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
};

describe("resolveContinuePushPlan", () => {
  it("offers commit and push for uncommitted work, on by default off the default branch", () => {
    expect(
      resolveContinuePushPlan({
        ...cleanStatus,
        hasWorkingTreeChanges: true,
        workingTree: {
          files: [
            { path: "a.ts", insertions: 1, deletions: 0 },
            { path: "b.ts", insertions: 2, deletions: 1 },
          ],
          insertions: 3,
          deletions: 1,
        },
      }),
    ).toEqual({
      kind: "push",
      action: "commit_push",
      defaultOn: true,
      summary: "2 files changed on feat/csv-export, not pushed",
    });
  });

  it("offers a plain push for unpushed commits or an unpublished branch", () => {
    expect(resolveContinuePushPlan({ ...cleanStatus, aheadCount: 1 })).toMatchObject({
      action: "push",
      summary: "1 commit on feat/csv-export not pushed",
    });
    expect(resolveContinuePushPlan({ ...cleanStatus, hasUpstream: false })).toMatchObject({
      action: "push",
      summary: "feat/csv-export is not on the remote yet",
    });
  });

  it("defaults off on the default branch", () => {
    expect(
      resolveContinuePushPlan({ ...cleanStatus, isDefaultRef: true, aheadCount: 2 }),
    ).toMatchObject({ kind: "push", defaultOn: false });
  });

  it("offers nothing when there is nothing to push or nowhere to push it", () => {
    expect(resolveContinuePushPlan(null)).toEqual({ kind: "none" });
    expect(resolveContinuePushPlan(cleanStatus)).toEqual({ kind: "none" });
    expect(
      resolveContinuePushPlan({ ...cleanStatus, hasPrimaryRemote: false, aheadCount: 3 }),
    ).toEqual({ kind: "none" });
    expect(resolveContinuePushPlan({ ...cleanStatus, refName: null, aheadCount: 3 })).toEqual({
      kind: "none",
    });
  });
});

describe("buildContinuationPrompt", () => {
  it("names the source and asks the agent to verify the branch checkout first", () => {
    const prompt = buildContinuationPrompt({
      sourceLabel: "Personal",
      sourceTitle: "CSV export",
      branch: "feat/csv-export",
      pushedBeforeHandoff: false,
    });
    expect(prompt).toContain('"CSV export", which ran on Personal');
    expect(prompt).toContain("origin/feat/csv-export");
    expect(prompt).toContain("push to feat/csv-export");
    expect(prompt.indexOf("check its state")).toBeLessThan(prompt.indexOf("pick up"));
    expect(prompt).not.toContain("handoff");
  });

  it("warns that a pre-handoff push makes the transcript's uncommitted state stale", () => {
    const prompt = buildContinuationPrompt({
      sourceLabel: "Personal",
      sourceTitle: "CSV export",
      branch: "feat/csv-export",
      pushedBeforeHandoff: true,
    });
    expect(prompt).toContain("committed and pushed to feat/csv-export");
  });

  it("still asks for a checkout check without a branch", () => {
    const prompt = buildContinuationPrompt({
      sourceLabel: "Personal",
      sourceTitle: "Notes",
      branch: null,
      pushedBeforeHandoff: false,
    });
    expect(prompt).toContain("had no branch");
    expect(prompt).not.toContain("origin/");
  });
});

describe("suggestContinuationProject", () => {
  const project = (
    id: string,
    environmentId: EnvironmentId,
    title: string,
    canonicalKey?: string,
  ) => ({
    id: ProjectId.make(id),
    environmentId,
    title,
    repositoryIdentity: canonicalKey ? { canonicalKey } : null,
  });

  it("prefers the target project tracking the same repository", () => {
    const source = project("src", personal, "web", "github.com/acme/web");
    const result = suggestContinuationProject(
      [
        project("other", work, "web", "github.com/acme/other"),
        project("same", work, "Web App", "GitHub.com/Acme/Web"),
        source,
      ],
      work,
      source,
    );
    expect(result).toMatchObject({ project: { id: "same" }, sameRepository: true });
  });

  it("falls back to a matching title, then the first target project", () => {
    const source = project("src", personal, "web");
    expect(
      suggestContinuationProject(
        [project("a", work, "api"), project("b", work, "web")],
        work,
        source,
      ),
    ).toMatchObject({ project: { id: "b" }, sameRepository: false });
    expect(suggestContinuationProject([project("a", work, "api")], work, source).project?.id).toBe(
      "a",
    );
    expect(suggestContinuationProject([source], work, source).project).toBeNull();
  });
});

describe("pickContinuationModel", () => {
  const entry = (instanceId: string, overrides: Partial<ProviderInstanceEntry> = {}) =>
    ({
      instanceId: ProviderInstanceId.make(instanceId),
      enabled: true,
      installed: true,
      isAvailable: true,
      snapshot: { auth: { status: "authenticated" } },
      models: [{ slug: "gpt-5", isLegacy: false }],
      ...overrides,
    }) as unknown as ProviderInstanceEntry;
  const source = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
  const fallback = { instanceId: ProviderInstanceId.make("claude"), model: "opus" };

  it("keeps the source model when the target can run it", () => {
    expect(pickContinuationModel(source, [entry("codex")], fallback)).toBe(source);
  });

  it("uses the target default when the source model is unavailable there", () => {
    expect(
      pickContinuationModel(
        source,
        [entry("codex", { snapshot: { auth: { status: "unauthenticated" } } } as never)],
        fallback,
      ),
    ).toBe(fallback);
    expect(pickContinuationModel(source, [entry("cursor")], fallback)).toBe(fallback);
    expect(pickContinuationModel(null, [entry("codex")], fallback)).toBe(fallback);
  });
});

describe("continue-on menu items", () => {
  const baseState = {
    canOperate: true,
    branch: null,
    projectFilter: null,
    isPinned: false,
    isSettled: false,
    autoSettleEnabled: true,
    isSnoozed: false,
    canSnoozeNow: true,
    isRegeneratingTitle: false,
    isRunning: false,
    supports: {
      settlement: false,
      autoSettleOptOut: false,
      snooze: false,
      pinning: false,
      titleRegeneration: false,
    },
    snoozePresets: [],
  };
  const targets = [
    { environmentId: "work", label: "Work", connected: true },
    { environmentId: "laptop", label: "Laptop", connected: false },
  ];
  const continueItem = (state: Parameters<typeof buildThreadActionMenuItems>[0]) =>
    buildThreadActionMenuItems(state).find((item) => item.id === "continue-on");

  it("lists each target, disabling offline ones", () => {
    expect(continueItem({ ...baseState, continueTargets: targets })?.children).toEqual([
      { id: "continue-on:work", label: "Work", icon: "laptop", disabled: false },
      { id: "continue-on:laptop", label: "Laptop (offline)", icon: "laptop", disabled: true },
    ]);
  });

  it("is hidden without targets and disabled while the thread runs", () => {
    expect(continueItem(baseState)).toBeUndefined();
    expect(continueItem({ ...baseState, continueTargets: [] })).toBeUndefined();
    const running = continueItem({ ...baseState, isRunning: true, continueTargets: targets });
    expect(running?.disabled).toBe(true);
    expect(running?.children?.every((child) => child.disabled)).toBe(true);
  });

  it("stays available to clients that cannot change threads on the source", () => {
    expect(threadActionRequiresOperate("continue-on:work")).toBe(false);
    expect(
      continueItem({ ...baseState, canOperate: false, continueTargets: targets })?.disabled,
    ).toBe(false);
  });
});
