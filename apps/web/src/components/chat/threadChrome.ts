import { useAtomValue } from "@effect/atom-react";
import type { OrchestrationV2ThreadProjection, ScopedThreadRef } from "@getpaperplane/contracts";
import {
  deriveLatestThreadRun,
  deriveProviderSubagentStatus,
  deriveReportedModelSelection,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadRuntime,
} from "@getpaperplane/client-runtime/state/thread-execution";
import { derivePendingThreadRequests } from "@getpaperplane/client-runtime/state/thread-requests";
import { deriveThreadCheckpointSummaries } from "@getpaperplane/client-runtime/state/thread-checkpoints";
import { threadSupportsProviderHandoff } from "@getpaperplane/client-runtime/state/thread-workflows";
import { workspacePreparationRetryRunIds } from "@getpaperplane/client-runtime/state/turn-item-presentation";
import {
  latestExecutedRun,
  latestRootProviderFailure,
  latestUnheldRun,
  usageLimitRunPresentedAsLatest,
} from "@getpaperplane/shared/orchestrationV2ThreadError";
import { derivePendingBackgroundWork } from "@getpaperplane/shared/orchestrationV2PendingBackgroundWork";
import { Atom } from "effect/reactivity";
import { parseScopedThreadKey, scopedThreadKey } from "@getpaperplane/client-runtime/environment";
import { structurallyEqual } from "../../hooks/useStructuralValue";
import { environmentThreadDetails } from "../../state/threads";
import { deriveActivePlanState, findLatestProposedPlan } from "../../session-logic";
import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "../../lib/contextWindow";
import { deriveCommittedServerUserMessageIds } from "../ChatView.logic";
import { hasDismissedResumeCompaction } from "./ContextWindowMeter.logic";

/** Only finished, semantic outputs belong here. Never retain a text-bearing
 * projection or compare the raw transcript to suppress notifications. */
function deriveThreadChrome(
  projection: OrchestrationV2ThreadProjection | null,
  visible: OrchestrationV2ThreadProjection["visibleTurnItems"],
) {
  const latestRun = projection ? deriveLatestThreadRun(projection) : null;
  const activityRun = projection ? deriveThreadActivityRun(projection) : null;
  const fullRuntime = projection ? deriveThreadRuntime(projection) : null;
  // updatedAt is an event clock, not runtime state (text appends advance it).
  const runtime =
    fullRuntime === null ? null : (({ updatedAt: _updatedAt, ...state }) => state)(fullRuntime);
  const committedUserMessageIds = [...deriveCommittedServerUserMessageIds(visible)];
  const acknowledgedUserMessageIds = [
    ...new Set([
      ...committedUserMessageIds,
      ...(projection?.messages ?? []).flatMap((message) =>
        message.role === "user" ? [message.id] : [],
      ),
    ]),
  ];
  const latestUserItem = visible.findLast((row) => row.item.type === "user_message")?.item;
  const executed = projection ? latestExecutedRun(projection.runs) : null;
  const resumableRunId =
    executed?.status === "interrupted" ||
    (executed?.status === "failed" &&
      runtime?.lastErrorClass === "usage_limit" &&
      latestRootProviderFailure(executed, projection?.turnItems ?? [])?.class === "usage_limit")
      ? executed.id
      : null;
  const sessionError =
    projection?.providerSessions.findLast(
      (session) => session.providerInstanceId === projection.thread.providerInstanceId,
    )?.lastError ?? null;
  const backgroundRun = projection
    ? (usageLimitRunPresentedAsLatest(projection.runs, projection.turnItems, sessionError) ??
      latestUnheldRun(projection.runs))
    : null;
  const turnDiffSummaries = projection ? deriveThreadCheckpointSummaries(projection) : [];
  const mutationItem =
    visible.findLast(
      ({ item }) =>
        (item.type === "command_execution" || item.type === "file_change") &&
        item.status !== "pending" &&
        item.status !== "running" &&
        item.status !== "waiting",
    )?.item.id ?? null;
  const checkpointCompletedAt = turnDiffSummaries.at(-1)?.completedAt ?? null;
  return {
    exists: projection !== null,
    latestRun,
    activityRun,
    runtime,
    runlessWorkStartedAt: projection ? deriveRunlessWorkStartedAt(projection) : null,
    providerSubagentStatus: projection ? deriveProviderSubagentStatus(projection) : null,
    reportedModelSelection: projection ? deriveReportedModelSelection(projection) : null,
    supportsProviderHandoff: threadSupportsProviderHandoff(projection),
    hasHeldQueuedRuns:
      projection?.runs.some((run) => run.status === "queued" && run.queueHeld === true) === true,
    resumableRunId,
    // Run entities and checkpoints do not carry streamed transcript text.
    runs: projection?.runs ?? [],
    checkpoints: projection?.checkpoints,
    turnDiffSummaries,
    workspaceMutationId:
      mutationItem === null && checkpointCompletedAt === null
        ? null
        : JSON.stringify([mutationItem, checkpointCompletedAt]),
    committedUserMessageIds,
    acknowledgedUserMessageIds,
    messageCount: Math.max(committedUserMessageIds.length, projection?.messages.length ?? 0),
    userMessageCount: committedUserMessageIds.length,
    latestUserMessageId:
      projection?.messages.findLast((message) => message.role === "user")?.id ?? null,
    activityUserMessageId:
      visible.flatMap(({ item }) =>
        item.type === "user_message" && item.runId === activityRun?.runId ? [item.messageId] : [],
      )[0] ?? null,
    latestUserIsCompact:
      latestUserItem?.type === "user_message" &&
      latestUserItem.text.trim().toLowerCase() === "/compact" &&
      latestUserItem.attachments.length === 0,
    latestUserRunId: latestUserItem?.runId ?? null,
    compactionSettled: visible.some(
      ({ item }) =>
        item.type === "compaction" &&
        item.runId === activityRun?.runId &&
        item.status === "completed",
    ),
    hasCompactableConversation: visible.some(
      ({ item }) =>
        item.type === "user_message" &&
        (item.text.trim().toLowerCase() !== "/compact" || item.attachments.length > 0),
    ),
    hasVisibleItems: visible.length > 0,
    pendingRequests: projection
      ? derivePendingThreadRequests(projection)
      : { approvals: [], userInputs: [] },
    activePlan: deriveActivePlanState(projection, activityRun?.runId),
    latestProposedPlan: findLatestProposedPlan(projection, latestRun?.runId ?? null),
    retryableRunIdsKey: [
      ...workspacePreparationRetryRunIds(projection?.runs ?? [], projection?.turnItems ?? []),
    ].join("\n"),
    promptCacheTtlMs: latestProviderTurnTokenUsage(projection?.providerTurns ?? [])
      ?.promptCacheTtlMs,
    contextWindow: deriveLatestContextWindowSnapshot(
      visible,
      latestProviderTurnTokenUsage(projection?.providerTurns ?? []),
      projection?.providerThreads.find(
        (thread) => thread.id === projection.thread.activeProviderThreadId,
      ),
    ),
    pendingBackgroundTasks: projection
      ? [
          ...derivePendingBackgroundWork({
            latestRun: backgroundRun,
            providerThreads: projection.providerThreads,
            turnItems: projection.turnItems,
            activeProviderThreadId: projection.thread.activeProviderThreadId,
            runs: projection.runs,
            pullRequests: projection.thread.pullRequests,
          }),
        ]
      : [],
    nativeResumeCompactionDismissed: hasDismissedResumeCompaction(
      (projection?.runtimeRequests ?? [])
        .filter((request) => request.kind === "user_input" && request.status === "resolved")
        .map((request) => ({ kind: "user-input.resolved", payload: { answers: request.answers } })),
    ),
    handoffFromModel: projection?.visibleTurnItems.length
      ? (projection.runs.findLast((run) => run.startedAt !== null && run.status !== "rolled_back")
          ?.modelSelection ?? null)
      : null,
  };
}

/** Equality happens inside the atom, before React subscribers are notified. */
function createThreadChromeAtom(
  projectionAtom: Atom.Atom<OrchestrationV2ThreadProjection | null>,
  visibleItemsAtom: Atom.Atom<OrchestrationV2ThreadProjection["visibleTurnItems"]>,
) {
  let previous: ReturnType<typeof deriveThreadChrome> | undefined;
  return Atom.make((get) => {
    const next = deriveThreadChrome(get(projectionAtom), get(visibleItemsAtom));
    if (previous !== undefined && structurallyEqual(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.setIdleTTL(0));
}

const emptyProjectionAtom = Atom.make<OrchestrationV2ThreadProjection | null>(null);
const emptyVisibleItemsAtom = Atom.make<OrchestrationV2ThreadProjection["visibleTurnItems"]>([]);
const emptyChromeAtom = createThreadChromeAtom(emptyProjectionAtom, emptyVisibleItemsAtom);
const chromeAtoms = Atom.family((key: string) => {
  const ref = parseScopedThreadKey(key);
  if (ref === null) return emptyChromeAtom;
  return createThreadChromeAtom(
    Atom.map(environmentThreadDetails.threadAtom(ref), (thread) => thread?.projection ?? null),
    environmentThreadDetails.visibleTurnItemsAtom(ref),
  ).pipe(Atom.withLabel(`web-thread-chrome:${key}`));
});

export function threadChromeAtom(ref: ScopedThreadRef | null) {
  return ref === null ? emptyChromeAtom : chromeAtoms(scopedThreadKey(ref));
}

export function useThreadChrome(ref: ScopedThreadRef | null) {
  return useAtomValue(threadChromeAtom(ref));
}
