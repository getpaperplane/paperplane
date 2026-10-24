import { RegistryContext } from "@effect/atom-react";
import { scopedThreadKey } from "@getpaperplane/client-runtime/environment";
import { resetHeldThreadTimeline } from "../ChatView.logic";
import {
  CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
  formatClaudeResumeCompactionQuestion,
} from "@getpaperplane/shared/claudeCompaction";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  PlanId,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type ScopedThreadRef,
} from "@getpaperplane/contracts";
import {
  applyOrchestrationV2ProjectionEvent,
  applyOrchestrationV2TextAppend,
} from "@getpaperplane/client-runtime/state/orchestration-v2-projection";
import { act, createRef, useRef } from "react";
import { ThreadFindProvider, ThreadFind, type ThreadFindControls } from "./ThreadFindProvider";
import type { useThreadFind } from "./useThreadFind";
import { create, type ReactTestRenderer } from "react-test-renderer";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeStreamingTimelineFixture, makeThreadProjectionFixture } from "../../test-fixtures";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readThreadProjection, readThreadVisibleTurnItems } from "../../state/entities";
import { ConnectedTimeline } from "./ConnectedTimeline";
import { threadChromeAtom, useThreadChrome } from "./threadChrome";
import type { TimelineScrollMode } from "./timelineScrollAnchoring";

// Replace only the incoming transport atom, not the selectors or connected hooks.
const source = vi.hoisted(() => ({
  publish: (_environmentId: EnvironmentId, _projection: OrchestrationV2ThreadProjection) => {},
}));
// SAFETY: the nullable bar slot is filled only by the typed find-bar test leaf.
const search = vi.hoisted(() => ({
  request: vi.fn((input: unknown) => input),
  refresh: vi.fn(),
  bar: null as ReturnType<typeof useThreadFind>["barProps"] | null,
}));
vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: { threadFind: search.request, threadFindProgressive: search.request },
}));
vi.mock("~/state/queries", () => ({ useDebouncedValue: <T,>(value: T) => value }));
vi.mock("~/state/query", () => {
  const result = {
    snapshotSequence: 1,
    totalMatches: 1,
    activeIndex: 0,
    match: { entryId: "live-assistant-item", runId: "live-run", occurrence: 0 },
  };
  return {
    useEnvironmentQuery: (atom: unknown) => ({
      data: atom === null ? null : result,
      isPending: false,
      error: null,
      refresh: search.refresh,
    }),
  };
});
vi.mock("./ThreadFindBar", () => ({
  ThreadFindBar: (props: NonNullable<typeof search.bar>) => {
    search.bar = props;
    return null;
  },
}));
vi.mock("../../state/threads", async () => {
  const { createEnvironmentThreadDetailAtoms, EMPTY_ENVIRONMENT_THREAD_STATE } =
    await import("@getpaperplane/client-runtime/state/threads");
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  const { appAtomRegistry: registry } = await import("../../rpc/atomRegistry");
  const atoms = Atom.family((_key: string) =>
    Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(Atom.keepAlive),
  );
  const stateAtom = (environmentId: EnvironmentId, threadId: ThreadId) =>
    atoms(JSON.stringify([environmentId, threadId]));
  source.publish = (environmentId, projection) =>
    registry.set(
      stateAtom(environmentId, projection.thread.id),
      AsyncResult.success({
        ...EMPTY_ENVIRONMENT_THREAD_STATE,
        status: "live",
        data: Option.some(projection),
      }),
    );
  return {
    environmentThreadDetails: createEnvironmentThreadDetailAtoms(stateAtom),
    environmentThreadShells: {},
  };
});

const environmentId = EnvironmentId.make("chrome-test");
const fixture = makeStreamingTimelineFixture("Initial");
const ref = { environmentId, threadId: fixture.threadId } satisfies ScopedThreadRef;
const now = DateTime.makeUnsafe(fixture.time(10));
const rootId = NodeId.make("root");
function makeProjection(): OrchestrationV2ThreadProjection {
  const base = makeThreadProjectionFixture();
  const live = fixture.visibleTurnItems.find(
    ({ item }) => item.id === TurnItemId.make("live-assistant-item"),
  )?.item;
  if (live?.type !== "assistant_message") throw new Error("Missing assistant fixture");
  const { messageId: _messageId, ...reasoningBase } = live;
  const reasoning = {
    ...reasoningBase,
    id: TurnItemId.make("live-reasoning"),
    type: "reasoning" as const,
  };
  const visible = [
    ...fixture.visibleTurnItems,
    {
      item: reasoning,
      position: 7,
      sourceItemId: reasoning.id,
      sourceThreadId: fixture.threadId,
      visibility: "local" as const,
    },
  ];
  return {
    ...base,
    thread: { ...base.thread, id: fixture.threadId },
    runs: [
      {
        id: fixture.historyRunId,
        threadId: fixture.threadId,
        ordinal: 1,
        status: "completed" as const,
      },
      { id: fixture.runId, threadId: fixture.threadId, ordinal: 2, status: "running" as const },
    ].map((run) => ({
      ...run,
      providerInstanceId: base.thread.providerInstanceId,
      modelSelection: base.thread.modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(run.ordinal === 1 ? "history-user" : "live-user"),
      rootNodeId: rootId,
      activeAttemptId: null,
      requestedAt: now,
      startedAt: now,
      completedAt: run.status === "completed" ? now : null,
      checkpointId: null,
      contextHandoffId: null,
    })),
    turnItems: visible.map((row) => row.item),
    visibleTurnItems: visible,
    messages: visible.flatMap(({ item }) =>
      item.type === "user_message" || item.type === "assistant_message"
        ? [
            {
              id: item.messageId,
              threadId: fixture.threadId,
              runId: item.runId,
              nodeId: null,
              role: item.type === "user_message" ? ("user" as const) : ("assistant" as const),
              text: item.text,
              attachments: [],
              streaming: item.type === "assistant_message" && item.streaming,
              createdBy: "user" as const,
              creationSource: "web" as const,
              createdAt: now,
              updatedAt: now,
            },
          ]
        : [],
    ),
  };
}
let projection = makeProjection();
let renderer: ReactTestRenderer | undefined;
let cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  search.request.mockClear();
  search.refresh.mockClear();
  resetHeldThreadTimeline();
  projection = makeProjection();
  source.publish(environmentId, projection);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function publish(next: OrchestrationV2ThreadProjection | null) {
  if (next === null) throw new Error("Reducer rejected fixture event");
  projection = next;
  source.publish(environmentId, projection);
}
function observeChrome() {
  const atom = threadChromeAtom(ref);
  cleanups.push(appAtomRegistry.mount(atom));
  const initial = appAtomRegistry.get(atom);
  const changed = vi.fn();
  cleanups.push(appAtomRegistry.subscribe(atom, changed));
  return { atom, initial, changed, read: () => appAtomRegistry.get(atom) };
}

describe("semantic thread chrome", () => {
  it.each([false, true])(
    "does not notify chrome for real assistant/reasoning appends or message.updated text (sparse plan: %s)",
    (withSparsePlan) => {
      if (withSparsePlan)
        publish({
          ...projection,
          plans: [
            {
              id: PlanId.make("sparse-plan"),
              threadId: ref.threadId,
              runId: fixture.runId,
              nodeId: rootId,
              kind: "proposed_plan",
              status: "active",
              markdown: "An earlier plan with a paged-out turn item",
            },
          ],
        });
      const chrome = observeChrome();
      for (let index = 0; index < 40; index++) {
        for (const id of ["live-assistant-item", "live-reasoning"]) {
          const item = projection.turnItems.find((item) => item.id === TurnItemId.make(id));
          if (item?.type !== "assistant_message" && item?.type !== "reasoning")
            throw new Error("Missing stream item");
          publish(
            applyOrchestrationV2TextAppend(projection, {
              kind: "text-append",
              sequence: index + 1,
              threadId: fixture.threadId,
              entity: { type: "turn-item", id: item.id },
              offset: item.text.length,
              append: "!",
              occurredAt: DateTime.makeUnsafe(fixture.time(11 + index)),
              updatedAt: DateTime.makeUnsafe(fixture.time(11 + index)),
            }),
          );
        }
        const message = projection.messages.find(
          (message) => message.id === MessageId.make("live-assistant"),
        );
        if (!message) throw new Error("Missing stream message");
        publish(
          applyOrchestrationV2ProjectionEvent(projection, {
            id: EventId.make(`message-${index}`),
            type: "message.updated",
            threadId: fixture.threadId,
            occurredAt: DateTime.makeUnsafe(fixture.time(11 + index)),
            payload: { ...message, text: message.text + "!", updatedAt: now },
          }),
        );
        expect(chrome.read()).toBe(chrome.initial);
      }
      expect(chrome.changed).not.toHaveBeenCalled();
      expect(readThreadProjection(ref)?.projection.messages.at(-1)?.text).toBe(
        "Initial" + "!".repeat(40),
      );
      expect(readThreadVisibleTurnItems(ref).at(-1)?.item).toMatchObject({
        text: "Initial" + "!".repeat(40),
      });
    },
  );

  it("notifies for run status/held queues, first persisted user ack and run failure text", () => {
    const chrome = observeChrome();
    const run = projection.runs[1]!;
    publish(
      applyOrchestrationV2ProjectionEvent(projection, {
        id: EventId.make("failed"),
        threadId: ref.threadId,
        occurredAt: now,
        type: "run.updated",
        payload: { ...run, status: "failed", completedAt: now },
      }),
    );
    expect(chrome.read().runtime?.status).toBe("failed");
    const item = projection.turnItems.find((item) => item.type === "user_message")!;
    const failure = {
      ...item,
      id: TurnItemId.make("root-error"),
      nodeId: rootId,
      runId: fixture.runId,
      type: "error" as const,
      status: "failed" as const,
      failure: {
        class: "usage_limit" as const,
        message: "Plan limit reached",
        code: null,
        retryable: null,
      },
    };
    publish(
      applyOrchestrationV2ProjectionEvent(projection, {
        id: EventId.make("error"),
        type: "turn-item.updated",
        threadId: ref.threadId,
        occurredAt: now,
        payload: failure,
      }),
    );
    expect(chrome.read().runtime).toMatchObject({
      lastError: "Plan limit reached",
      lastErrorClass: "usage_limit",
    });
    expect(chrome.read().resumableRunId).toBe(run.id);
    publish(
      applyOrchestrationV2ProjectionEvent(projection, {
        id: EventId.make("error-text"),
        type: "turn-item.updated",
        threadId: ref.threadId,
        occurredAt: now,
        payload: { ...failure, failure: { ...failure.failure, message: "Quota resets tomorrow" } },
      }),
    );
    expect(chrome.read().runtime?.lastError).toBe("Quota resets tomorrow");
    const queued = {
      ...run,
      id: RunId.make("queued"),
      ordinal: 3,
      status: "queued" as const,
      queueHeld: true,
      startedAt: null,
    };
    publish(
      applyOrchestrationV2ProjectionEvent(projection, {
        id: EventId.make("queued"),
        type: "run.created",
        threadId: ref.threadId,
        occurredAt: now,
        payload: queued,
      }),
    );
    expect(chrome.read().hasHeldQueuedRuns).toBe(true);
    const user = projection.messages.find((message) => message.role === "user")!;
    publish(
      applyOrchestrationV2ProjectionEvent(projection, {
        id: EventId.make("new-user"),
        type: "message.updated",
        threadId: ref.threadId,
        occurredAt: now,
        payload: {
          ...user,
          id: MessageId.make("queued-user"),
          runId: queued.id,
          text: "Queued from another client",
        },
      }),
    );
    expect(chrome.read().acknowledgedUserMessageIds).toContain(MessageId.make("queued-user"));
    expect(chrome.read().latestUserMessageId).toBe(MessageId.make("queued-user"));
    expect(chrome.changed).toHaveBeenCalled();
  });

  it("keeps usage, reported model, plans and workspace/checkpoint metadata live", () => {
    const chrome = observeChrome();
    const providerThread = {
      id: ProviderThreadId.make("provider-thread"),
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: projection.thread.providerInstanceId,
      providerSessionId: ProviderSessionId.make("session"),
      appThreadId: ref.threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle" as const,
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      nativeMetadata: {
        modelSelection: { ...projection.thread.modelSelection, model: "reported" },
      },
      contextUsage: { contextUsageState: "known" as const, usedTokens: 123, maxTokens: 1000 },
    };
    publish({
      ...projection,
      thread: { ...projection.thread, activeProviderThreadId: providerThread.id },
      providerThreads: [providerThread],
    });
    expect(chrome.read().reportedModelSelection?.model).toBe("reported");
    expect(chrome.read().contextWindow?.usedTokens).toBe(123);
    publish(
      applyOrchestrationV2ProjectionEvent(projection, {
        id: EventId.make("usage"),
        type: "provider-turn.updated",
        threadId: ref.threadId,
        occurredAt: now,
        payload: {
          id: ProviderTurnId.make("turn"),
          providerThreadId: providerThread.id,
          nodeId: rootId,
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: now,
          completedAt: null,
          tokenUsage: {
            usedTokens: 456,
            maxTokens: 2000,
            promptCacheTtlMs: 5000,
            updatedAt: fixture.time(12),
          },
        },
      }),
    );
    expect(chrome.read().contextWindow?.usedTokens).toBe(456);
    expect(chrome.read().promptCacheTtlMs).toBe(5000);
    publish(
      applyOrchestrationV2ProjectionEvent(projection, {
        id: EventId.make("plan"),
        type: "plan.updated",
        threadId: ref.threadId,
        occurredAt: now,
        payload: {
          id: PlanId.make("plan"),
          threadId: ref.threadId,
          runId: fixture.runId,
          nodeId: rootId,
          kind: "todo_list",
          status: "active",
          steps: [{ id: "step", text: "Verify", status: "pending" }],
        },
      }),
    );
    expect(chrome.read().activePlan?.steps[0]?.step).toBe("Verify");
    publish(
      applyOrchestrationV2ProjectionEvent(projection, {
        id: EventId.make("proposal"),
        type: "plan.updated",
        threadId: ref.threadId,
        occurredAt: now,
        payload: {
          id: PlanId.make("proposal"),
          threadId: ref.threadId,
          runId: fixture.runId,
          nodeId: rootId,
          kind: "proposed_plan",
          status: "active",
          markdown: "Implement the isolation",
        },
      }),
    );
    expect(chrome.read().latestProposedPlan?.planMarkdown).toBe("Implement the isolation");
    publish(
      applyOrchestrationV2ProjectionEvent(projection, {
        id: EventId.make("checkpoint"),
        type: "checkpoint.captured",
        threadId: ref.threadId,
        occurredAt: now,
        payload: {
          id: CheckpointId.make("checkpoint"),
          scopeId: CheckpointScopeId.make("scope"),
          threadId: ref.threadId,
          runId: fixture.runId,
          nodeId: rootId,
          parentCheckpointId: null,
          ordinalWithinScope: 0,
          appRunOrdinal: 2,
          ref: CheckpointRef.make("refs/rove/test"),
          status: "ready",
          files: [],
          capturedAt: now,
        },
      }),
    );
    expect(chrome.read().turnDiffSummaries[0]?.assistantMessageId).toBe(
      MessageId.make("live-assistant"),
    );
    const beforeMutation = chrome.read().workspaceMutationId;
    const command = projection.turnItems.find((item) => item.type === "command_execution")!;
    publish(
      applyOrchestrationV2ProjectionEvent(projection, {
        id: EventId.make("mutation"),
        type: "turn-item.updated",
        threadId: ref.threadId,
        occurredAt: now,
        payload: {
          ...command,
          id: TurnItemId.make("new-command"),
          ordinal: 20,
          runId: fixture.runId,
          status: "completed",
        },
      }),
    );
    expect(chrome.read().workspaceMutationId).not.toBe(beforeMutation);
    expect(chrome.changed).toHaveBeenCalled();
  });

  it("updates pending questions and resolved-request compaction semantics", () => {
    const chrome = observeChrome();
    const requestId = RuntimeRequestId.make("question");
    const request = {
      id: requestId,
      nodeId: rootId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input" as const,
      status: "pending" as const,
      responseCapability: { type: "message" as const },
      createdAt: now,
      resolvedAt: null,
    };
    const base = projection.turnItems.find((item) => item.type === "user_message")!;
    publish(
      applyOrchestrationV2ProjectionEvent(projection, {
        id: EventId.make("question-item"),
        type: "turn-item.updated",
        threadId: ref.threadId,
        occurredAt: now,
        payload: {
          ...base,
          type: "user_input_request",
          id: TurnItemId.make("question"),
          requestId,
          responseMode: "message",
          questions: [{ id: "next", header: "Next", question: "Continue?", options: [] }],
        },
      }),
    );
    publish(
      applyOrchestrationV2ProjectionEvent(projection, {
        id: EventId.make("question"),
        type: "runtime-request.updated",
        threadId: ref.threadId,
        occurredAt: now,
        payload: request,
      }),
    );
    expect(chrome.read().pendingRequests.userInputs[0]?.questions[0]?.question).toBe("Continue?");
    publish(
      applyOrchestrationV2ProjectionEvent(projection, {
        id: EventId.make("resolved"),
        type: "runtime-request.updated",
        threadId: ref.threadId,
        occurredAt: now,
        payload: {
          ...request,
          status: "resolved",
          resolvedAt: now,
          answers: {
            [formatClaudeResumeCompactionQuestion({ ageMinutes: 70, estimatedTokens: 200000 })]:
              CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
          },
        },
      }),
    );
    expect(chrome.read().pendingRequests.userInputs).toHaveLength(0);
    expect(chrome.read().nativeResumeCompactionDismissed).toBe(true);
    publish(
      applyOrchestrationV2ProjectionEvent(projection, {
        id: EventId.make("approval-item"),
        type: "turn-item.updated",
        threadId: ref.threadId,
        occurredAt: now,
        payload: {
          ...base,
          type: "approval_request",
          id: TurnItemId.make("approval"),
          requestId,
          requestKind: "command",
          prompt: "Allow shell?",
        },
      }),
    );
    publish(
      applyOrchestrationV2ProjectionEvent(projection, {
        id: EventId.make("approval"),
        type: "runtime-request.updated",
        threadId: ref.threadId,
        occurredAt: now,
        payload: {
          ...request,
          kind: "command",
          responseCapability: {
            type: "live",
            providerSessionId: ProviderSessionId.make("session"),
          },
        },
      }),
    );
    expect(chrome.read().pendingRequests.approvals[0]?.detail).toBe("Allow shell?");
    expect(chrome.changed).toHaveBeenCalled();
  });

  it("notifies for provider-native runless work and its completion", () => {
    publish({
      ...projection,
      runs: [],
      thread: {
        ...projection.thread,
        creationSource: "provider",
        lineage: {
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "subagent",
          rootThreadId: ThreadId.make("parent"),
        },
      },
    });
    const chrome = observeChrome();
    const node = {
      id: rootId,
      rootNodeId: rootId,
      threadId: ref.threadId,
      runId: null,
      parentNodeId: null,
      kind: "root_turn" as const,
      status: "running" as const,
      countsForRun: false,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    };
    publish(
      applyOrchestrationV2ProjectionEvent(projection, {
        id: EventId.make("runless"),
        type: "node.updated",
        threadId: ref.threadId,
        occurredAt: now,
        payload: node,
      }),
    );
    expect(chrome.read().runlessWorkStartedAt).toBe(DateTime.formatIso(now));
    publish(
      applyOrchestrationV2ProjectionEvent(projection, {
        id: EventId.make("runless-done"),
        type: "node.updated",
        threadId: ref.threadId,
        occurredAt: now,
        payload: { ...node, status: "completed", completedAt: now },
      }),
    );
    expect(chrome.read().runlessWorkStartedAt).toBeNull();
    expect(chrome.read().providerSubagentStatus?.status).toBe("completed");
    expect(chrome.changed).toHaveBeenCalled();
  });
});

const noOp = () => {};
describe("connected transcript boundary", () => {
  it("refreshes an open search from live content without rerendering the chrome owner", () => {
    vi.useFakeTimers();
    let ownerRenders = 0;
    const controls = createRef<ThreadFindControls>();
    function Owner() {
      useThreadChrome(ref);
      ownerRenders++;
      return (
        <ThreadFindProvider
          thread={ref}
          contentThreadRef={ref}
          enabled
          controlsRef={controls}
          onOpenChange={noOp}
        >
          <ThreadFind onClose={noOp} />
        </ThreadFindProvider>
      );
    }
    act(() => {
      renderer = create(
        <RegistryContext.Provider value={appAtomRegistry}>
          <Owner />
        </RegistryContext.Provider>,
      );
    });
    act(() => controls.current?.open());
    act(() => search.bar?.onQueryChange("Initial"));
    const before = search.request.mock.calls.length;
    const ownerBefore = ownerRenders;
    const item = projection.turnItems.find(
      (item) => item.type === "assistant_message" && item.streaming,
    );
    if (item?.type !== "assistant_message") throw new Error("Missing live assistant");
    act(() =>
      publish(
        applyOrchestrationV2TextAppend(projection, {
          kind: "text-append",
          sequence: 1,
          threadId: ref.threadId,
          entity: { type: "turn-item", id: item.id },
          offset: item.text.length,
          append: " new searchable text",
          occurredAt: now,
          updatedAt: now,
        }),
      ),
    );
    act(() => vi.advanceTimersByTime(300));
    expect(search.request.mock.calls.length + search.refresh.mock.calls.length).toBeGreaterThan(
      before,
    );
    expect(ownerRenders).toBe(ownerBefore);
    expect(search.bar?.query).toBe("Initial");
  });

  it("advances actual timeline text without notifying its chrome owner; retargets by thread AND environment", () => {
    let ownerRenders = 0;
    const painted: string[] = [];
    function Owner({ threadRef, loading }: { threadRef: ScopedThreadRef; loading: boolean }) {
      const chrome = useThreadChrome(threadRef);
      ownerRenders++;
      const scrollMode = useRef<TimelineScrollMode>("free-scrolling");
      const promotions = useRef<Record<string, true>>({});
      return (
        <ConnectedTimeline
          routeThreadDetailRef={threadRef}
          environmentId={threadRef.environmentId}
          activeThreadKey={scopedThreadKey(threadRef)}
          routeThreadKey={scopedThreadKey(threadRef)}
          isServerThread
          syncing={loading}
          threadDetailLoading={loading || !chrome.exists}
          optimisticUserMessages={[]}
          feedbackSubmissions={[]}
          attachmentPreviewHandoffByMessageId={{}}
          attachmentPreviewPromotionInFlightByMessageIdRef={promotions}
          clearAttachmentPreviewHandoff={noOp}
          gitCwd={null}
          activeWorkspaceRoot={undefined}
          onReleaseToolAnchor={noOp}
          timelineScrollModeRef={scrollMode}
          anchorMessageId={null}
          runningTurnId={chrome.runtime?.activeRunId ?? null}
          liveFollowEnabled={false}
        >
          {({ displayedTimeline }) => {
            const messages = displayedTimeline.entries.flatMap((entry) =>
              entry.kind === "message" ? [entry.message.text] : [],
            );
            painted.push(messages.at(-1) ?? "");
            return <p>{messages.at(-1)}</p>;
          }}
        </ConnectedTimeline>
      );
    }
    const view = (threadRef: ScopedThreadRef, loading = false) => (
      <RegistryContext.Provider value={appAtomRegistry}>
        <Owner threadRef={threadRef} loading={loading} />
      </RegistryContext.Provider>
    );
    act(() => {
      renderer = create(view(ref));
    });
    const mountedRenders = ownerRenders;
    for (let index = 0; index < 4; index++) {
      const item = projection.turnItems.find(
        (item) => item.type === "assistant_message" && item.streaming,
      );
      if (item?.type !== "assistant_message") throw new Error("Missing live assistant");
      act(() =>
        publish(
          applyOrchestrationV2TextAppend(projection, {
            kind: "text-append",
            sequence: index + 1,
            threadId: ref.threadId,
            entity: { type: "turn-item", id: item.id },
            offset: item.text.length,
            append: "!",
            occurredAt: now,
            updatedAt: now,
          }),
        ),
      );
      expect(painted.at(-1)).toBe("Initial" + "!".repeat(index + 1));
      expect(ownerRenders).toBe(mountedRenders);
    }
    // A same-environment loading switch can paint the remembered thread, but
    // must swap it out once the new empty detail is ready.
    const loadingRef = { ...ref, threadId: ThreadId.make("loading-b") };
    act(() => renderer?.update(view(loadingRef, true)));
    expect(painted.at(-1)).toBe("Initial!!!!");
    source.publish(environmentId, {
      ...makeProjection(),
      thread: { ...projection.thread, id: loadingRef.threadId },
      visibleTurnItems: [],
      turnItems: [],
      messages: [],
    });
    act(() => renderer?.update(view(loadingRef)));
    expect(painted.at(-1)).toBe("");
    const remote = EnvironmentId.make("remote-chrome");
    source.publish(remote, {
      ...makeProjection(),
      visibleTurnItems: [],
      turnItems: [],
      messages: [],
    });
    act(() => renderer?.update(view({ ...ref, environmentId: remote })));
    expect(painted.at(-1)).toBe("");
    const otherId = ThreadId.make("thread-b");
    source.publish(environmentId, {
      ...makeProjection(),
      thread: { ...projection.thread, id: otherId },
      visibleTurnItems: [],
      turnItems: [],
      messages: [],
    });
    act(() => renderer?.update(view({ environmentId, threadId: otherId })));
    expect(painted.at(-1)).toBe("");
    act(() => renderer?.update(view(ref)));
    expect(painted.at(-1)).toBe("Initial!!!!");
  });
});
