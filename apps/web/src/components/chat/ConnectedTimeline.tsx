import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import type { EnvironmentId, MessageId, ScopedThreadRef } from "@rove-code/contracts";
import { parseScopedThreadKey } from "@rove-code/client-runtime/environment";
import {
  codexFeedbackMessage,
  type CodexFeedbackSubmission,
} from "@rove-code/client-runtime/state/threads";
import { useAssetUrls } from "../../assets/assetUrls";
import { useThreadProjection, useThreadVisibleTurnItems } from "../../state/entities";
import {
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  selectHandoffImageResources,
  type TimelineEntriesProjection,
} from "../../session-logic";
import type { ChatMessage } from "../../types";
import {
  isPaintOnlyThreadTimeline,
  peekHeldThreadTimeline,
  peekRememberedThreadTimeline,
  rememberReadyThreadTimeline,
  resolveThreadSwitchTimeline,
  timelineHasEphemeralPreviewUrls,
  shouldReleaseTimelineAnchorForToolActivity,
} from "../ChatView.logic";
import type { TimelineScrollMode } from "./timelineScrollAnchoring";

interface TimelineInput {
  routeThreadDetailRef: ScopedThreadRef | null;
  environmentId: EnvironmentId;
  activeThreadKey: string | null;
  routeThreadKey: string;
  isServerThread: boolean;
  syncing: boolean;
  threadDetailLoading: boolean;
  optimisticUserMessages: ChatMessage[];
  feedbackSubmissions: ReadonlyArray<CodexFeedbackSubmission>;
  attachmentPreviewHandoffByMessageId: Record<string, string[]>;
  attachmentPreviewPromotionInFlightByMessageIdRef: RefObject<Record<string, true>>;
  clearAttachmentPreviewHandoff: (messageId: MessageId, urls?: ReadonlyArray<string>) => void;
  gitCwd: string | null;
  activeWorkspaceRoot: string | undefined;
  onReleaseToolAnchor: () => void;
  timelineScrollModeRef: RefObject<TimelineScrollMode>;
  anchorMessageId: MessageId | null;
  runningTurnId: import("@rove-code/contracts").RunId | null;
  liveFollowEnabled: boolean;
}

/** The only chat owner of the streaming projection. It adds no DOM or context
 * boundary; the existing timeline still lives inside the same find canvas. */
export function ConnectedTimeline({
  children,
  ...input
}: TimelineInput & {
  children: (state: ReturnType<typeof useConnectedTimeline>) => ReactNode;
}) {
  const state = useConnectedTimeline(input);
  return children(state);
}

function useConnectedTimeline({
  routeThreadDetailRef,
  environmentId,
  activeThreadKey,
  routeThreadKey,
  isServerThread,
  syncing,
  threadDetailLoading,
  optimisticUserMessages,
  feedbackSubmissions,
  attachmentPreviewHandoffByMessageId,
  attachmentPreviewPromotionInFlightByMessageIdRef,
  clearAttachmentPreviewHandoff,
  gitCwd,
  activeWorkspaceRoot,
  onReleaseToolAnchor,
  timelineScrollModeRef,
  anchorMessageId,
  runningTurnId,
  liveFollowEnabled,
}: TimelineInput) {
  const serverProjection = useThreadProjection(routeThreadDetailRef)?.projection ?? null;
  const serverVisibleTurnItems = useThreadVisibleTurnItems(routeThreadDetailRef);
  const serverAttachmentResources = useMemo(
    () =>
      selectHandoffImageResources(
        Object.keys(attachmentPreviewHandoffByMessageId).length === 0
          ? undefined
          : serverVisibleTurnItems.flatMap(({ item }) =>
              item.type === "user_message"
                ? [{ id: item.messageId, role: "user" as const, attachments: item.attachments }]
                : [],
            ),
        attachmentPreviewHandoffByMessageId,
      ),
    [serverVisibleTurnItems, attachmentPreviewHandoffByMessageId],
  );
  const serverAttachmentUrls = useAssetUrls(environmentId, serverAttachmentResources);
  const serverAttachmentUrlById = useMemo(
    () =>
      new Map(
        serverAttachmentResources.flatMap((resource, index) => {
          const url = serverAttachmentUrls[index];
          return url ? [[resource.attachmentId, url] as const] : [];
        }),
      ),
    [serverAttachmentResources, serverAttachmentUrls],
  );

  useEffect(() => {
    if (typeof Image === "undefined" || serverVisibleTurnItems.length === 0) return;
    const cleanups: Array<() => void> = [];
    const users = new Map(
      serverVisibleTurnItems.flatMap(({ item }) =>
        item.type === "user_message" ? [[String(item.messageId), item] as const] : [],
      ),
    );
    const inFlight = attachmentPreviewPromotionInFlightByMessageIdRef.current;
    for (const [messageId, handoffUrls] of Object.entries(attachmentPreviewHandoffByMessageId)) {
      if (inFlight[messageId]) continue;
      const message = users.get(messageId);
      if (!message?.attachments.length) continue;
      const urls = message.attachments.flatMap((attachment) => {
        const url =
          attachment.type === "image" ? serverAttachmentUrlById.get(attachment.id) : undefined;
        return url ? [url] : [];
      });
      if (
        urls.length === 0 ||
        urls.length !== handoffUrls.length ||
        urls.some((url) => url.startsWith("blob:"))
      )
        continue;
      inFlight[messageId] = true;
      let cancelled = false;
      const images: HTMLImageElement[] = [];
      void Promise.all(
        urls.map(
          (url) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              images.push(image);
              image.addEventListener("load", () => resolve(), { once: true });
              image.addEventListener(
                "error",
                () => reject(new Error(`Failed to load server preview for ${messageId}.`)),
                { once: true },
              );
              image.src = url;
            }),
        ),
      )
        .then(() => {
          if (!cancelled) clearAttachmentPreviewHandoff(message.messageId, handoffUrls);
        })
        .catch(() => {
          if (!cancelled) delete inFlight[messageId];
        });
      cleanups.push(() => {
        cancelled = true;
        delete inFlight[messageId];
        for (const image of images) image.src = "";
      });
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [
    serverVisibleTurnItems,
    attachmentPreviewHandoffByMessageId,
    attachmentPreviewPromotionInFlightByMessageIdRef,
    serverAttachmentUrlById,
    clearAttachmentPreviewHandoff,
  ]);

  const timelineAttachmentUrlById = useMemo(() => {
    const urls = new Map(serverAttachmentUrlById);
    for (const { item } of serverVisibleTurnItems) {
      if (item.type !== "user_message") continue;
      const handoffUrls = attachmentPreviewHandoffByMessageId[item.messageId];
      if (handoffUrls === undefined) continue;
      let index = 0;
      for (const attachment of item.attachments) {
        if (attachment.type !== "image") continue;
        const url = handoffUrls[index++];
        if (url !== undefined) urls.set(attachment.id, url);
      }
    }
    return urls;
  }, [serverVisibleTurnItems, serverAttachmentUrlById, attachmentPreviewHandoffByMessageId]);
  const anchoredTimelineMessages = useMemo(
    () =>
      feedbackSubmissions.flatMap((submission) =>
        submission.status === "interrupted"
          ? []
          : [
              { ...codexFeedbackMessage(submission), runId: null },
              { ...codexFeedbackMessage(submission, "assistant"), runId: null },
            ],
      ),
    [feedbackSubmissions],
  );
  const timelineProjectionRef = useRef<{
    threadKey: string | null;
    projection: TimelineEntriesProjection;
  } | null>(null);
  const serverTimelineEntries = useMemo(() => {
    const previous = timelineProjectionRef.current;
    const projection = deriveTimelineEntriesFromVisibleTurnItemsWithState(
      {
        visibleTurnItems: serverVisibleTurnItems,
        optimisticMessages: optimisticUserMessages,
        anchoredMessages: anchoredTimelineMessages,
        attachmentUrlById: timelineAttachmentUrlById,
        attempts: serverProjection?.attempts ?? [],
        nodes: serverProjection?.nodes ?? [],
        plans: serverProjection?.plans ?? [],
      },
      previous?.threadKey === activeThreadKey ? previous.projection : null,
    );
    timelineProjectionRef.current = { threadKey: activeThreadKey, projection };
    return projection.entries;
  }, [
    activeThreadKey,
    serverVisibleTurnItems,
    optimisticUserMessages,
    anchoredTimelineMessages,
    timelineAttachmentUrlById,
    serverProjection,
  ]);
  const draftTimelineEntries = useMemo(
    () =>
      optimisticUserMessages.map((message) => ({
        id: message.id,
        kind: "message" as const,
        createdAt: message.createdAt,
        message,
      })),
    [optimisticUserMessages],
  );
  const timelineEntries = isServerThread ? serverTimelineEntries : draftTimelineEntries;
  const displayedTimeline = resolveThreadSwitchTimeline({
    loading: timelineEntries.length === 0 && syncing,
    activeThreadKey,
    nextEntries: timelineEntries,
    rememberedForActive: peekRememberedThreadTimeline<typeof timelineEntries>(activeThreadKey),
  });
  const displayedTimelineKey = displayedTimeline.displayThreadKey ?? routeThreadKey;
  const paintOnlyDisplayedTimeline = isPaintOnlyThreadTimeline(
    displayedTimeline.displayThreadKey,
    activeThreadKey,
  );
  const displayedThreadRef = parseScopedThreadKey(displayedTimelineKey);
  useLayoutEffect(() => {
    if (
      threadDetailLoading ||
      timelineEntries.length === 0 ||
      timelineHasEphemeralPreviewUrls(timelineEntries)
    )
      return;
    rememberReadyThreadTimeline({
      threadKey: activeThreadKey,
      entries: timelineEntries,
      markdownCwd: gitCwd,
      workspaceRoot: activeWorkspaceRoot ?? null,
    });
  }, [activeThreadKey, activeWorkspaceRoot, gitCwd, threadDetailLoading, timelineEntries]);
  useLayoutEffect(() => {
    if (timelineScrollModeRef.current !== "anchoring-new-turn") return;
    if (
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled,
        runningTurnId,
        timelineEntries,
      })
    ) {
      onReleaseToolAnchor();
    }
  }, [
    onReleaseToolAnchor,
    timelineScrollModeRef,
    timelineEntries,
    anchorMessageId,
    runningTurnId,
    liveFollowEnabled,
  ]);
  const heldPaintContext = paintOnlyDisplayedTimeline
    ? peekHeldThreadTimeline<typeof timelineEntries>()
    : null;
  return {
    serverProjection,
    timelineEntries,
    displayedTimeline,
    displayedTimelineKey,
    paintOnlyDisplayedTimeline,
    displayedThreadRef,
    heldPaintContext,
  };
}
