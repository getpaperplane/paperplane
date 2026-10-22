import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProjectId,
  type ServerSettings,
} from "@rove-code/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SettingsTarget } from "./settings-environment-filter";
import {
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
} from "./settings-scoped-server";

const firstId = "first" as EnvironmentId;
const secondId = "second" as EnvironmentId;
const firstProject = "first-project" as ProjectId;
const secondProject = "second-project" as ProjectId;

describe("mobile usage-limit settings across environments", () => {
  it.each(["autoResumeLimitedThreads", "snoozeLimitedThreads"] as const)(
    "shows %s as mixed and can enable it everywhere without changing other settings",
    (key) => {
      const targets = resolveMobileSettingsTargets(
        [
          environment(firstId, { ...DEFAULT_SERVER_SETTINGS, [key]: true }),
          environment(secondId, { ...DEFAULT_SERVER_SETTINGS, [key]: false }),
        ],
        null,
      );

      expect(uniformMobileSetting(targets, key)).toBeNull();
      const writes = planMobileScopedSettingsPatch(targets, false, { [key]: true });
      expect(writes).toEqual([
        { environmentId: firstId, patch: { [key]: true } },
        { environmentId: secondId, patch: { [key]: true } },
      ]);
      const updatedTargets = targets.map((target) => ({
        ...target,
        settings: {
          ...target.settings,
          [key]:
            writes.find((write) => write.environmentId === target.environment.environmentId)?.patch[
              key
            ] ?? target.settings[key],
        },
      }));
      expect(uniformMobileSetting(updatedTargets, key)).toBe(true);
      expect(uniformMobileSetting(targets.slice(0, 1), key)).toBe(true);
      expect(uniformMobileSetting(targets.slice(1), key)).toBe(false);
      expect(uniformMobileSetting([], key)).toBeNull();
    },
  );
});

function environment(environmentId: EnvironmentId, settings: ServerSettings): SettingsTarget {
  return {
    environmentId,
    serverConfig: {
      settings,
      environment: { capabilities: { projectSettingsOverrides: true } },
    },
  } as SettingsTarget;
}

describe("mobile project settings scope", () => {
  it("merges custom cleanup edits with each checkout's effective rules and resets only cleanup", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      storageCleanup: {
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeAfterDays: 17,
        worktreeOnMerge: true,
      },
      projectSettingsOverrides: {
        [firstProject]: { defaultAutoPull: true, worktreeCleanup: { mode: "off" } },
      },
    };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, settings)],
      [
        { environmentId: firstId, id: firstProject },
        { environmentId: firstId, id: secondProject },
      ],
    );
    const writes = planMobileScopedSettingsPatch(targets, true, {
      worktreeCleanup: { mode: "custom", rules: { worktreeOnDelete: true } },
    });
    expect(writes).toHaveLength(1);
    const overrides = writes[0]!.patch.projectSettingsOverrides!;
    expect(overrides[firstProject]).toMatchObject({
      defaultAutoPull: true,
      worktreeCleanup: {
        mode: "custom",
        rules: { worktreeAfterDays: null, worktreeOnMerge: false, worktreeOnDelete: true },
      },
    });
    expect(overrides[secondProject]).toMatchObject({
      worktreeCleanup: {
        mode: "custom",
        rules: { worktreeAfterDays: 17, worktreeOnMerge: true, worktreeOnDelete: true },
      },
    });
    expect(writes[0]!.patch.storageCleanup).toBeUndefined();
    expect(
      planMobileScopedSettingsPatch(targets, true, { storageCleanup: { logsAfterDays: 30 } }),
    ).toEqual([]);
    expect(
      planMobileScopedSettingsPatch(targets, true, { worktreesDirectory: "/tmp/elsewhere" }),
    ).toEqual([]);
    expect(
      planMobileScopedSettingsClear(targets, ["worktreeCleanup"])[0]!.patch
        .projectSettingsOverrides,
    ).toEqual({
      [firstProject]: { defaultAutoPull: true },
      [secondProject]: null,
    });
    expect(settings.storageCleanup.worktreeAfterDays).toBe(17);
    expect(settings.projectSettingsOverrides[firstProject]?.worktreeCleanup?.mode).toBe("off");
  });
  it("edits each checkout's own override without changing either environment default", () => {
    const firstSettings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      responseStreamingMode: "paragraph",
      projectSettingsOverrides: { [firstProject]: { defaultAutoPull: true } },
    };
    const secondSettings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      responseStreamingMode: "turn",
      projectSettingsOverrides: {},
    };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, firstSettings), environment(secondId, secondSettings)],
      [
        { environmentId: firstId, id: firstProject },
        { environmentId: secondId, id: secondProject },
      ],
    );

    const writes = planMobileScopedSettingsPatch(targets, true, {
      responseStreamingMode: "turn",
    });
    expect(writes).toEqual([
      {
        environmentId: firstId,
        patch: {
          projectSettingsOverrides: {
            [firstProject]: { defaultAutoPull: true, responseStreamingMode: "turn" },
          },
        },
      },
      {
        environmentId: secondId,
        patch: { projectSettingsOverrides: { [secondProject]: { responseStreamingMode: "turn" } } },
      },
    ]);
    expect(firstSettings.responseStreamingMode).toBe("paragraph");
    expect(secondSettings.responseStreamingMode).toBe("turn");
  });

  it("removes a project override when a picker sends null for a key that cannot store it", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [firstProject]: { defaultThreadEnvMode: "worktree", defaultAutoPull: true },
      },
    };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, settings)],
      [{ environmentId: firstId, id: firstProject }],
    );
    expect(planMobileScopedSettingsPatch(targets, true, { defaultThreadEnvMode: null })).toEqual([
      {
        environmentId: firstId,
        patch: { projectSettingsOverrides: { [firstProject]: { defaultAutoPull: true } } },
      },
    ]);
    expect(planMobileScopedSettingsPatch(targets, true, { defaultModelSelection: null })).toEqual([
      {
        environmentId: firstId,
        patch: {
          projectSettingsOverrides: {
            [firstProject]: {
              defaultThreadEnvMode: "worktree",
              defaultAutoPull: true,
              defaultModelSelection: null,
            },
          },
        },
      },
    ]);
  });

  it("resets only the selected page's override and rejects environment-wide writes", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [firstProject]: { defaultAutoPull: true, responseStreamingMode: "turn" },
      },
    };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, settings)],
      [{ environmentId: firstId, id: firstProject }],
    );

    expect(planMobileScopedSettingsClear(targets, ["responseStreamingMode"])).toEqual([
      {
        environmentId: firstId,
        patch: { projectSettingsOverrides: { [firstProject]: { defaultAutoPull: true } } },
      },
    ]);
    expect(
      planMobileScopedSettingsPatch(targets, true, { enableProviderUpdateChecks: false }),
    ).toEqual([]);
  });
});
