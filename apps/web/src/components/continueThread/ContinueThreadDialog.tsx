import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@getpaperplane/client-runtime/environment";
import { threadRuntimeCanArchive } from "@getpaperplane/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@getpaperplane/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  EnvironmentRequestInvalidError,
  ProjectId,
  resolveEnvironmentMachineKind,
  type ModelSelection,
  type ProviderInstanceId,
  type ScopedThreadRef,
} from "@getpaperplane/contracts";
import { resolveProjectSettings } from "@getpaperplane/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { GitBranchIcon, HistoryIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { create } from "zustand";

import type { ComposerFileAttachment } from "../../composerDraftStore";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseAttachmentUpload,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { threadContextAttachment } from "../../lib/threadContextAttachment";
import { newMessageId, newThreadId, randomUUID } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  readThreadShell,
  useProjects,
  useThreadShell,
  waitForThreadShell,
} from "../../state/entities";
import { useEnvironment, useEnvironments } from "../../state/environments";
import { orchestrationEnvironment } from "../../state/orchestration";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useGitStackedAction } from "../../state/sourceControlActions";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { vcsEnvironment } from "../../state/vcs";
import { buildThreadRouteParams } from "../../threadRoutes";
import { fileAttachmentStagingLimit } from "../chat/composerAttachmentFiles";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildContinuationPrompt,
  pickContinuationModel,
  resolveContinuePushPlan,
  resolveContinueTargets,
  suggestContinuationProject,
  type ContinueTarget,
  type ContinueTargetCandidate,
} from "./continueThread.logic";

interface ContinueRequest {
  readonly sourceRef: ScopedThreadRef;
  /** Preselected target; null picks the first connected one. */
  readonly targetEnvironmentId: EnvironmentId | null;
}

const useContinueThreadStore = create<{ request: ContinueRequest | null }>(() => ({
  request: null,
}));

function openContinueThread(request: ContinueRequest): void {
  useContinueThreadStore.setState({ request });
}

function closeContinueThread(): void {
  useContinueThreadStore.setState({ request: null });
}

const isEnvironmentRequestInvalidError = Schema.is(EnvironmentRequestInvalidError);

function presentationCandidates(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly connected: boolean;
  }>,
  canOperate: (environmentId: EnvironmentId) => boolean,
): ContinueTargetCandidate[] {
  return environments.map((environment) => ({
    ...environment,
    canOperate: canOperate(environment.environmentId),
  }));
}

/** Snapshot for menus built at open time (context menus). */
export function readContinueTargets(
  sourceEnvironmentId: EnvironmentId,
): ReadonlyArray<ContinueTarget> {
  const presentations = appAtomRegistry.get(environmentPresentations.presentationsAtom);
  return resolveContinueTargets(
    sourceEnvironmentId,
    presentationCandidates(
      [...presentations.entries()].map(([environmentId, presentation]) => ({
        environmentId,
        label: presentation.entry.target.label,
        connected:
          presentation.connection.phase === "connected" && presentation.serverConfig !== null,
      })),
      (environmentId) => readEnvironmentScope(environmentId, AuthOrchestrationOperateScope),
    ),
  );
}

export function useContinueTargets(
  sourceEnvironmentId: EnvironmentId | null,
): ReadonlyArray<ContinueTarget> {
  const { environments } = useEnvironments();
  const permitted = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  return useMemo(
    () =>
      sourceEnvironmentId === null
        ? []
        : resolveContinueTargets(
            sourceEnvironmentId,
            presentationCandidates(
              environments.map((environment) => ({
                environmentId: environment.environmentId,
                label: environment.label,
                connected:
                  environment.connection.phase === "connected" && environment.serverConfig !== null,
              })),
              (environmentId) => permitted.has(environmentId),
            ),
          ),
    [environments, permitted, sourceEnvironmentId],
  );
}

export function ContinueThreadDialogHost() {
  const request = useContinueThreadStore((state) => state.request);
  return request ? (
    <ContinueThreadDialog key={scopedThreadKey(request.sourceRef)} request={request} />
  ) : null;
}

function ContinueThreadDialog({ request }: { request: ContinueRequest }) {
  const targets = useContinueTargets(request.sourceRef.environmentId);
  const { environments } = useEnvironments();
  const [targetId, setTargetId] = useState<EnvironmentId | null>(
    () =>
      request.targetEnvironmentId ??
      targets.find((target) => target.connected)?.environmentId ??
      null,
  );
  const [busy, setBusy] = useState(false);
  const target = targets.find((candidate) => candidate.environmentId === targetId) ?? null;
  const machineById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [
          environment.environmentId,
          resolveEnvironmentMachineKind(environment.serverConfig),
        ]),
      ),
    [environments],
  );

  const environmentField = (
    <div className="flex flex-col gap-1.5">
      <Label>Environment</Label>
      <Select
        value={targetId ?? ""}
        disabled={busy}
        onValueChange={(value) => value && setTargetId(EnvironmentId.make(value))}
      >
        <SelectTrigger>
          <SelectValue>
            {target ? (
              <span className="flex items-center gap-2">
                <EnvironmentMachineIcon
                  kind={machineById.get(target.environmentId) ?? "server"}
                  className="size-4"
                />
                {target.label}
              </span>
            ) : (
              "Choose an environment"
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {targets.map((option) => (
            <SelectItem
              key={option.environmentId}
              value={option.environmentId}
              disabled={!option.connected}
            >
              <span className="flex items-center gap-2">
                <EnvironmentMachineIcon
                  kind={machineById.get(option.environmentId) ?? "server"}
                  className="size-4"
                />
                {option.connected ? option.label : `${option.label} (offline)`}
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && closeContinueThread()}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Continue on another environment</DialogTitle>
          <DialogDescription>
            Start a thread on another machine with this thread’s history. This thread stays here.
          </DialogDescription>
        </DialogHeader>
        {target?.connected ? (
          <ContinueThreadForm
            key={target.environmentId}
            sourceRef={request.sourceRef}
            target={target}
            environmentField={environmentField}
            onBusyChange={setBusy}
          />
        ) : (
          <>
            <DialogPanel>{environmentField}</DialogPanel>
            <DialogFooter>
              <Button variant="ghost" onClick={closeContinueThread}>
                Cancel
              </Button>
              <Button disabled>Continue</Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

type ContinueStep = "push" | "export" | "upload" | "create" | "link";

const STEP_LABELS = {
  push: "Pushing…",
  export: "Reading history…",
  upload: "Copying history…",
  create: "Starting thread…",
  link: "Linking threads…",
} satisfies Record<ContinueStep, string>;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function readSupportsContinuation(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId))?.serverConfig
      ?.environment.capabilities.threadContinuation === true
  );
}

function ContinueThreadForm(props: {
  readonly sourceRef: ScopedThreadRef;
  readonly target: ContinueTarget;
  readonly environmentField: ReactNode;
  readonly onBusyChange: (busy: boolean) => void;
}) {
  const { sourceRef, target, onBusyChange } = props;
  const navigate = useNavigate();
  const sourceThread = useThreadShell(sourceRef);
  const sourceEnvironment = useEnvironment(sourceRef.environmentId);
  const targetEnvironment = useEnvironment(target.environmentId);
  const projects = useProjects();
  const sourceProject =
    sourceThread === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === sourceRef.environmentId &&
            project.id === sourceThread.projectId,
        ) ?? null);
  const sourceLabel = sourceEnvironment?.label.trim() || "another environment";
  const sourceRunning = sourceThread !== null && !threadRuntimeCanArchive(sourceThread.runtime);

  // Push: only a thread with a branch has work the target can fetch.
  const sourceCwd = sourceThread?.worktreePath ?? sourceProject?.workspaceRoot ?? null;
  const sourceBranch = sourceThread?.branch ?? null;
  const vcsScope = useMemo(
    () => ({ environmentId: sourceRef.environmentId, cwd: sourceCwd }),
    [sourceCwd, sourceRef.environmentId],
  );
  const status = useEnvironmentQuery(
    sourceBranch !== null && sourceCwd !== null
      ? vcsEnvironment.status({
          environmentId: sourceRef.environmentId,
          input: { cwd: sourceCwd },
        })
      : null,
  ).data;
  const branch = sourceBranch === null ? null : (status?.refName ?? sourceBranch);
  const pushPlan = resolveContinuePushPlan(sourceBranch === null ? null : status);
  const stackedAction = useGitStackedAction(vcsScope);
  const [pushChoice, setPushChoice] = useState<boolean | null>(null);
  const canPush = pushPlan.kind === "push" && stackedAction.isAllowed;
  const push = canPush && (pushChoice ?? pushPlan.defaultOn);

  // Project: same repository suggested, the user confirms.
  const targetProjects = useMemo(
    () => projects.filter((project) => project.environmentId === target.environmentId),
    [projects, target.environmentId],
  );
  const suggestion = useMemo(
    () => suggestContinuationProject(targetProjects, target.environmentId, sourceProject),
    [sourceProject, target.environmentId, targetProjects],
  );
  const [projectChoice, setProjectChoice] = useState<ProjectId | null>(null);
  const project =
    targetProjects.find((candidate) => candidate.id === projectChoice) ?? suggestion.project;

  // Model: the target's own catalog and settings.
  const settings = useEnvironmentSettings(target.environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(target.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(
          deriveProviderInstanceEntries(providers),
          settings,
          project?.id ?? null,
        ),
      ),
    [project?.id, providers, settings],
  );
  const [modelChoice, setModelChoice] = useState<ModelSelection | null>(null);
  const modelSelection =
    modelChoice ??
    pickContinuationModel(
      sourceThread?.modelSelection ?? null,
      instanceEntries,
      scheduledTaskDefaultModel(settings, project, instanceEntries),
    );
  const activeInstanceId =
    modelSelection?.instanceId ?? instanceEntries[0]?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = modelSelection?.model ?? "";
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers, activeInstanceId, activeModel),
    [activeInstanceId, activeModel, providers, settings],
  );
  const runtimeMode = resolveProjectSettings(settings, project?.id ?? null, project ?? undefined)
    .settings.defaultRuntimeMode;

  const loadTranscript = useAtomCommand(orchestrationEnvironment.threadTranscript, {
    reportFailure: false,
  });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });

  const [step, setStep] = useState<ContinueStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);
  const busy = step !== null;

  const run = async () => {
    if (runningRef.current || sourceThread === null || project === null || modelSelection === null)
      return;
    runningRef.current = true;
    onBusyChange(true);
    setError(null);
    const fail = (message: string) => {
      setError(message);
      setStep(null);
      runningRef.current = false;
      onBusyChange(false);
    };

    if (push && pushPlan.kind === "push") {
      setStep("push");
      const pushed = await stackedAction.run({
        actionId: randomUUID(),
        action: pushPlan.action,
        threadId: sourceRef.threadId,
      });
      if (pushed._tag === "Failure") {
        fail(
          isAtomCommandInterrupted(pushed)
            ? "The push was cancelled."
            : `Could not push ${branch}: ${errorMessage(squashAtomCommandFailure(pushed), "the push failed.")}`,
        );
        return;
      }
    }

    setStep("export");
    const transcript = await loadTranscript({
      environmentId: sourceRef.environmentId,
      input: { threadId: sourceRef.threadId },
    });
    if (transcript._tag !== "Success") {
      const failure = squashAtomCommandFailure(transcript);
      fail(
        isEnvironmentRequestInvalidError(failure) &&
          failure.reason === "thread_transcript_too_large"
          ? "This thread’s history is too large to copy. Start a fresh thread there instead."
          : `Could not read this thread’s history. Check that ${sourceLabel} is connected and up to date.`,
      );
      return;
    }
    const file = threadContextAttachment(sourceRef.environmentId, transcript.value);
    const capabilities = targetEnvironment?.serverConfig?.environment.capabilities;
    const maxBytes = fileAttachmentStagingLimit({
      attachmentUploadsCapabilityKnown: capabilities !== undefined,
      supportsAttachmentUploads: capabilities?.attachmentUploads === true,
      maxFileAttachmentBytes: capabilities?.fileAttachments?.maxUploadBytes ?? null,
    });
    if (maxBytes === null) {
      fail(`${target.label} does not accept file attachments. Update Paperplane there first.`);
      return;
    }
    if (file.size > maxBytes) {
      fail(`This thread’s history is larger than ${target.label} accepts as an attachment.`);
      return;
    }

    setStep("upload");
    const upload: ComposerFileAttachment = {
      type: "file",
      id: randomUUID(),
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      file,
    };
    startAttachmentUpload({ environmentId: target.environmentId, image: upload });
    await awaitAttachmentUploads([upload.id]);
    const attachments = getUploadedAttachments({
      environmentId: target.environmentId,
      images: [upload],
    });
    if (attachments === null) {
      const state = readAttachmentUpload(upload.id);
      releaseAttachmentUpload(upload.id);
      fail(
        `Could not copy the history to ${target.label}: ${state?.status === "failed" ? state.reason : "the upload failed"}.`,
      );
      return;
    }

    setStep("create");
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    const started = await startThreadTurn({
      environmentId: target.environmentId,
      input: {
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: buildContinuationPrompt({
            sourceLabel,
            sourceTitle: sourceThread.title,
            branch,
            pushedBeforeHandoff: push && pushPlan.kind === "push",
          }),
          attachments,
        },
        modelSelection,
        runtimeMode,
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId: project.id,
            title: sourceThread.title,
            modelSelection,
            runtimeMode,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
          },
          // A worktree from origin/<branch> picks up the pushed work without
          // touching whatever the target's own checkout has in progress.
          ...(branch === null
            ? {}
            : {
                prepareWorktree: {
                  projectCwd: project.workspaceRoot,
                  baseBranch: branch,
                  startFromOrigin: true,
                },
                runSetupScript: true,
              }),
        },
        createdAt,
      },
    });
    releaseAttachmentUpload(upload.id);
    if (started._tag === "Failure") {
      fail(
        isAtomCommandInterrupted(started)
          ? "Starting the thread was cancelled."
          : `Could not start the thread on ${target.label}: ${errorMessage(squashAtomCommandFailure(started), "an error occurred.")}`,
      );
      return;
    }

    setStep("link");
    const at = new Date().toISOString();
    const linkResults = await Promise.all([
      readSupportsContinuation(target.environmentId)
        ? updateThreadMetadata({
            environmentId: target.environmentId,
            input: {
              threadId,
              continuedFrom: {
                environmentId: sourceRef.environmentId,
                environmentLabel: sourceLabel,
                threadId: sourceRef.threadId,
                title: sourceThread.title,
                at,
              },
            },
          })
        : null,
      readSupportsContinuation(sourceRef.environmentId) &&
      readEnvironmentScope(sourceRef.environmentId, AuthOrchestrationOperateScope)
        ? updateThreadMetadata({
            environmentId: sourceRef.environmentId,
            input: {
              threadId: sourceRef.threadId,
              continuedOn: {
                environmentId: target.environmentId,
                environmentLabel: target.label.trim() || "another environment",
                threadId,
                title: sourceThread.title,
                at,
              },
            },
          })
        : null,
    ]);
    if (linkResults.some((result) => result?._tag === "Failure")) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Continued without links",
          description: "The new thread started, but the two threads could not be linked.",
        }),
      );
    }

    const targetRef = scopeThreadRef(target.environmentId, threadId);
    await waitForThreadShell(targetRef);
    runningRef.current = false;
    onBusyChange(false);
    closeContinueThread();
    await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(targetRef) });
  };

  const blockedReason =
    sourceThread === null
      ? "This thread is no longer available."
      : sourceRunning
        ? "This thread is still running. Stop it or wait for it to finish first."
        : targetProjects.length === 0
          ? `${target.label} has no projects. Add this repository there first.`
          : modelSelection === null
            ? `${target.label} has no available model.`
            : null;

  return (
    <>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          {props.environmentField}
          <div className="flex flex-col gap-1.5">
            <Label>Project</Label>
            <Select
              value={project?.id ?? ""}
              disabled={busy || targetProjects.length === 0}
              onValueChange={(value) => value && setProjectChoice(ProjectId.make(value))}
            >
              <SelectTrigger>
                <SelectValue>
                  {project ? (
                    <span className="flex min-w-0 items-center gap-2">
                      {project.title}
                      <span className="truncate text-muted-foreground">
                        {project.workspaceRoot}
                      </span>
                    </span>
                  ) : (
                    "No projects"
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {targetProjects.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {suggestion.sameRepository && project?.id === suggestion.project?.id ? (
              <p className="text-xs text-muted-foreground">
                Suggested because it tracks the same repository.
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Model</Label>
            <div>
              <ProviderModelPicker
                environmentId={target.environmentId}
                disabled={busy}
                activeInstanceId={activeInstanceId}
                model={activeModel}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                isComposerOwned={false}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onInstanceModelChange={(instanceId, model) => setModelChoice({ instanceId, model })}
              />
            </div>
          </div>
          {canPush && pushPlan.kind === "push" ? (
            <Alert variant="warning">
              <GitBranchIcon />
              <AlertTitle>{pushPlan.summary}</AlertTitle>
              <AlertDescription>
                <label className="mt-1 flex items-center gap-2 text-foreground">
                  <Checkbox
                    checked={push}
                    disabled={busy}
                    onCheckedChange={(checked) => setPushChoice(checked)}
                  />
                  {pushPlan.action === "commit_push"
                    ? "Commit and push before continuing"
                    : "Push before continuing"}
                </label>
                <span className="mt-1 block">
                  Runs on {sourceLabel} without the agent. {target.label} starts from the pushed
                  branch.
                </span>
              </AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="error">
              <TriangleAlertIcon />
              <AlertTitle>Could not continue</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <HistoryIcon className="mt-0.5 size-3.5 shrink-0" />
            {blockedReason ??
              `Copies this thread’s history as an attachment${branch ? ` and checks out ${branch}` : ""}. Diffs, checkpoints and the provider session stay on ${sourceLabel}.`}
          </p>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={closeContinueThread}>
          Cancel
        </Button>
        <Button disabled={busy || blockedReason !== null} onClick={() => void run()}>
          {step !== null
            ? STEP_LABELS[step]
            : `${push ? "Push and continue" : "Continue"} on ${target.label}`}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Shortcut on the usage-limit banner: straight to the dialog with this target preselected.
 * It sits beside the banner's ghost recovery buttons, so it matches them and caps a long
 * environment label to keep the row on one line at composer width.
 */
export function ContinueOnBannerButton(props: {
  readonly threadRef: ScopedThreadRef;
  readonly target: ContinueTarget;
  /** Drop the machine name when the banner also shows reset actions, so the reset time stays readable. */
  readonly compact?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              openContinueThread({
                sourceRef: props.threadRef,
                targetEnvironmentId: props.target.environmentId,
              })
            }
          />
        }
      >
        {props.compact ? (
          "Continue on…"
        ) : (
          <>
            Continue on <span className="max-w-28 truncate">{props.target.label}</span>
          </>
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">Continue this thread on {props.target.label}</TooltipPopup>
    </Tooltip>
  );
}

/** Opens the dialog for a thread unless it is still running. */
export function requestContinueThread(
  sourceRef: ScopedThreadRef,
  targetEnvironmentId: EnvironmentId | null,
): void {
  const thread = readThreadShell(sourceRef);
  if (thread !== null && !threadRuntimeCanArchive(thread.runtime)) {
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: "This thread is still running",
        description: "Stop it or wait for it to finish, then continue elsewhere.",
      }),
    );
    return;
  }
  openContinueThread({ sourceRef, targetEnvironmentId });
}
