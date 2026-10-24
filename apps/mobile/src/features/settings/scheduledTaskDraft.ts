import type {
  ModelSelection,
  ServerConfig,
  ProjectId,
  RuntimeMode,
  ScheduledTask,
  ScheduledTaskUpsertSchedule,
} from "@getpaperplane/contracts";

import { DEFAULT_SERVER_SETTINGS } from "@getpaperplane/contracts";
import {
  WEBHOOK_SIGNATURE_DEFAULTS,
  parseMaxDeliveryAge,
  webhookSignatureForUpsert,
} from "@getpaperplane/client-runtime/scheduled-task-webhook";
import {
  resolveProjectSettings,
  type LegacyProjectSettingsFields,
} from "@getpaperplane/shared/projectSettings";
import {
  buildModelOptions,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
} from "../../lib/modelOptions";

export function scheduledTaskDefaultModel(
  config: ServerConfig | null,
  project: (LegacyProjectSettingsFields & { readonly id: ProjectId }) | null,
): ModelSelection | null {
  const settings = config?.settings ?? DEFAULT_SERVER_SETTINGS;
  const configured = resolveProjectSettings(settings, project?.id ?? null, project).settings
    .defaultModelSelection;
  const projectDefaultSelection =
    resolveDefaultableModelSelection(config, configured, project?.id ?? null) ??
    resolveDefaultableModelSelection(config, settings.defaultModelSelection, project?.id ?? null);
  return resolveNewTaskModelSelection({
    draftSelection: null,
    projectDefaultSelection,
    stickySelection: null,
    modelOptions: buildModelOptions(
      config,
      projectDefaultSelection,
      undefined,
      project?.id ?? null,
    ),
  });
}

export type ScheduleDraft = {
  readonly mode: "fixed_time" | "interval" | "webhook";
  readonly timeOfDay: string;
  readonly weekdays: ReadonlyArray<number>;
  readonly intervalMinutes: string;
  readonly signatureEnabled: boolean;
  readonly signatureHeader: string;
  readonly signatureEncoding: "hex" | "base64";
  readonly signaturePrefix: string;
  /** Write-only and in memory only: empty keeps the secret already stored on the server. */
  readonly signatureSecret: string;
  /** Minutes as typed; empty runs every held request regardless of age. */
  readonly maxDeliveryAgeMinutes: string;
};

export const DEFAULT_SCHEDULE: ScheduleDraft = {
  mode: "fixed_time",
  timeOfDay: "09:00",
  weekdays: [1, 2, 3, 4, 5],
  intervalMinutes: "15",
  signatureEnabled: false,
  ...WEBHOOK_SIGNATURE_DEFAULTS,
  signatureSecret: "",
  maxDeliveryAgeMinutes: "",
};

export function scheduleDraftForTask(task: Pick<ScheduledTask, "schedule">): ScheduleDraft {
  switch (task.schedule.type) {
    case "fixed_time":
      return {
        ...DEFAULT_SCHEDULE,
        timeOfDay: task.schedule.timeOfDay,
        weekdays: task.schedule.weekdays?.length
          ? [...new Set(task.schedule.weekdays)].sort((a, b) => a - b)
          : [0, 1, 2, 3, 4, 5, 6],
      };
    case "interval":
      return {
        ...DEFAULT_SCHEDULE,
        mode: "interval",
        intervalMinutes: String(Math.max(1, task.schedule.everyMs / 60_000)),
      };
    case "webhook":
      return {
        ...DEFAULT_SCHEDULE,
        mode: "webhook",
        ...(task.schedule.signature
          ? {
              signatureEnabled: true,
              signatureHeader: task.schedule.signature.header,
              signatureEncoding: task.schedule.signature.encoding,
              signaturePrefix: task.schedule.signature.prefix,
            }
          : {}),
        maxDeliveryAgeMinutes:
          task.schedule.maxDeliveryAgeMinutes == null
            ? ""
            : String(task.schedule.maxDeliveryAgeMinutes),
      };
  }
}

export function scheduleFromDraft(draft: ScheduleDraft): ScheduledTaskUpsertSchedule | null {
  if (draft.mode === "webhook") {
    const maxDeliveryAgeMinutes = parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes);
    if (maxDeliveryAgeMinutes === undefined) return null;
    return {
      type: "webhook",
      signature: webhookSignatureForUpsert({
        enabled: draft.signatureEnabled,
        header: draft.signatureHeader,
        encoding: draft.signatureEncoding,
        prefix: draft.signaturePrefix,
        secret: draft.signatureSecret,
      }),
      maxDeliveryAgeMinutes,
    };
  }
  if (draft.mode === "interval") {
    const minutes = Number(draft.intervalMinutes);
    // Undo floating-point noise from displaying existing millisecond intervals as minutes.
    const everyMs = Math.round(minutes * 60_000);
    return minutes >= 1 && Number.isSafeInteger(everyMs) ? { type: "interval", everyMs } : null;
  }
  const weekdays = [...new Set(draft.weekdays)].sort((a, b) => a - b);
  if (
    !/^([01]?\d|2[0-3]):[0-5]\d$/.test(draft.timeOfDay) ||
    weekdays.length === 0 ||
    weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  ) {
    return null;
  }
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay,
    ...(weekdays.length === 7 ? {} : { weekdays }),
  };
}

type Workspace = "worktree" | "root" | "existing_worktree";
export type ScheduledTaskDraft = {
  readonly task: ScheduledTask | null;
  readonly title: string;
  readonly prompt: string;
  readonly projectId: ProjectId | null;
  readonly modelSelection: ModelSelection | null;
  readonly modelSelectionIsExplicit: boolean;
  readonly schedule: ScheduleDraft;
  readonly workspace: Workspace;
  readonly baseRef: string;
  readonly checkoutPath: string;
  readonly enabled: boolean;
  readonly startFromOrigin: boolean;
  readonly runtimeMode: RuntimeMode;
};

function draftSignature(draft: ScheduledTaskDraft): string {
  return JSON.stringify([
    draft.title,
    draft.prompt,
    draft.projectId,
    draft.modelSelection?.instanceId,
    draft.modelSelection?.model,
    [...(draft.modelSelection?.options ?? [])]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((option) => [option.id, option.value]),
    draft.schedule.mode,
    draft.schedule.timeOfDay,
    [...draft.schedule.weekdays].sort((a, b) => a - b),
    draft.schedule.intervalMinutes,
    draft.schedule.maxDeliveryAgeMinutes,
    draft.schedule.signatureEnabled,
    draft.schedule.signatureHeader,
    draft.schedule.signatureEncoding,
    draft.schedule.signaturePrefix,
    // Only whether a secret was typed; the value itself is never copied into the comparison.
    draft.schedule.signatureSecret !== "",
    draft.workspace,
    draft.baseRef,
    draft.checkoutPath,
    draft.enabled,
    draft.startFromOrigin,
    draft.runtimeMode,
  ]);
}

export function hasScheduledTaskDraftChanges(
  initial: ScheduledTaskDraft,
  current: ScheduledTaskDraft,
): boolean {
  return draftSignature(initial) !== draftSignature(current);
}

export function createDraft(
  projectId: ProjectId | null,
  modelSelection: ModelSelection | null,
): ScheduledTaskDraft {
  return {
    task: null,
    title: "",
    prompt: "",
    projectId,
    modelSelection,
    modelSelectionIsExplicit: false,
    schedule: DEFAULT_SCHEDULE,
    workspace: "worktree",
    baseRef: "main",
    checkoutPath: "",
    enabled: true,
    startFromOrigin: true,
    runtimeMode: "full-access",
  };
}

export function editDraft(task: ScheduledTask): ScheduledTaskDraft {
  return {
    task,
    title: task.title,
    prompt: task.prompt,
    projectId: task.projectId,
    modelSelection: task.modelSelection,
    modelSelectionIsExplicit: true,
    schedule: scheduleDraftForTask(task),
    workspace: task.workspaceStrategy.type,
    baseRef: task.workspaceStrategy.type === "worktree" ? task.workspaceStrategy.baseRef : "main",
    checkoutPath:
      task.workspaceStrategy.type === "existing_worktree"
        ? task.workspaceStrategy.worktreePath
        : "",
    enabled: task.enabled,
    startFromOrigin:
      task.workspaceStrategy.type === "worktree"
        ? (task.workspaceStrategy.startFromOrigin ?? false)
        : true,
    runtimeMode: task.runtimeMode,
  };
}
