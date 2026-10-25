// @vitest-environment jsdom

/**
 * PAPERPLANE_RENDER_BENCH=1 vp test run src/components/chat/renderWaste.bench.test.tsx
 *
 * Real: client-runtime detail/shell atom factories and text/shell reducers,
 * timeline entry reuse, MessagesTimeline/row bodies/Markdown, ChatComposer and
 * its draft store, ChatHeader. Each input is flushed in a separate React act.
 * Leaf substitutes: LegendList renders a fixed window of every fixture row
 * (no layout/virtualization), Tiptap exposes its controlled onChange contract,
 * diff workers and Mermaid. DOM observers/media queries have inert shims.
 * No transport is mounted; writable atoms replace the incoming stream boundary.
 *
 * This is NOT a full-app benchmark. ChatView couples router, connection/command,
 * workspace, terminal and panel lifecycles. Reconstructing those in jsdom would
 * require mocking the owners whose work we want to measure. The small owner
 * below subscribes like ChatView but does not reproduce its body or prop graph.
 * Sidebar/app root/right-panel bodies are unmounted; their store notifications
 * are reported separately and must not be called component renders.
 *
 * Profiler commits count committed SUBTREE updates, not function invocations.
 * actualMs is React render work in those commits, not DOM commit-phase time.
 * Nested durations overlap. jsdom/dev timings exclude layout, paint, real
 * editor cost, transport batching, CPU utilization and retained heap. Compare
 * counts first; use this baseline only against the same harness/configuration.
 *
 * Leaf groups (`leaf:*`) wrap real, separately exported composer leaves in a
 * React.memo wrapper with the same props as the real component and a Profiler
 * inside it. A commit is therefore a prop change that reached the leaf; the
 * real leaf may still bail out internally, which shows up as a small actualMs.
 * Leaves defined inside ChatComposer.tsx (ComposerFooterModeControls,
 * ComposerFooterPrimaryActions) cannot be wrapped from a test without editing
 * product code, so they are not reported separately. Their wrapped children
 * (CompactComposerControlsMenu, ComposerPrimaryActions) are reported instead.
 * `provider-ready typing` mounts an available provider so these controls exist.
 */

import * as NodeProcess from "node:process";

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { PrimaryConnectionTarget } from "@getpaperplane/client-runtime/connection";
import { applyShellStreamEvent } from "@getpaperplane/client-runtime/state/shell";
import { applyOrchestrationV2TextAppend } from "@getpaperplane/client-runtime/state/orchestration-v2-projection";
import {
  EMPTY_THREAD_HISTORY_META,
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  type EnvironmentThreadState,
} from "@getpaperplane/client-runtime/state/threads";
import {
  EnvironmentId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
} from "@getpaperplane/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  act,
  createRef,
  memo,
  Profiler,
  useMemo,
  useRef,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, afterAll, describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useTurnDiffSummaries } from "../../hooks/useTurnDiffSummaries";
import {
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  type TimelineEntriesProjection,
} from "../../session-logic";
import { makeStreamingTimelineFixture, makeThreadProjectionFixture } from "../../test-fixtures";
import { useRightPanelStore, selectThreadRightPanelState } from "../../rightPanelStore";
import type { ComposerPromptEditorProps } from "../ComposerPromptEditor";

const instrument = vi.hoisted<{
  onRender: ComponentProps<typeof Profiler>["onRender"];
  editor: ComposerPromptEditorProps | null;
  editorRenders: number;
  ownerRenders: number;
}>(() => ({
  onRender: () => {},
  editor: null,
  editorRenders: 0,
  ownerRenders: 0,
}));

// Keep each real leaf; only observe its committed prop-change renders.
function profileLeaf<Props extends object>(id: string, Leaf: ComponentType<Props>) {
  return memo(function ProfiledLeaf(props: Props) {
    return (
      <Profiler id={`leaf:${id}`} onRender={instrument.onRender}>
        <Leaf {...props} />
      </Profiler>
    );
  });
}
vi.mock("./ProviderModelPicker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ProviderModelPicker")>();
  return {
    ...actual,
    ProviderModelPicker: profileLeaf("ProviderModelPicker", actual.ProviderModelPicker),
  };
});
vi.mock("./TraitsPicker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./TraitsPicker")>();
  return { ...actual, TraitsPicker: profileLeaf("TraitsPicker", actual.TraitsPicker) };
});
vi.mock("./CompactComposerControlsMenu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./CompactComposerControlsMenu")>();
  return {
    ...actual,
    CompactComposerControlsMenu: profileLeaf(
      "CompactComposerControlsMenu",
      actual.CompactComposerControlsMenu,
    ),
  };
});
vi.mock("./ComposerPrimaryActions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ComposerPrimaryActions")>();
  return {
    ...actual,
    ComposerPrimaryActions: profileLeaf("ComposerPrimaryActions", actual.ComposerPrimaryActions),
  };
});
vi.mock("../ComposerPromptEditor", () => ({
  ComposerPromptEditor(props: ComposerPromptEditorProps) {
    instrument.editorRenders++;
    instrument.editor = props;
    return <textarea aria-label="Benchmark prompt" value={props.value} readOnly />;
  },
}));
vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("./MermaidDiagram", () => ({ MermaidDiagram: () => <svg /> }));
vi.mock("@legendapp/list/react", () => ({
  // Memoized cells preserve ordinary prop bailouts, but real row context
  // updates still propagate through them and are captured by their Profiler.
  LegendList: function BenchList(props: {
    data: ReadonlyArray<{ id: string; kind: string }>;
    keyExtractor: (item: { id: string; kind: string }) => string;
    renderItem: (input: { item: { id: string; kind: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) {
    return (
      <div>
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <BenchCell key={props.keyExtractor(item)} item={item} renderItem={props.renderItem} />
        ))}
        {props.ListFooterComponent}
      </div>
    );
  },
}));

const BenchCell = memo(function BenchCell(props: {
  item: { id: string; kind: string };
  renderItem: (input: { item: { id: string; kind: string } }) => ReactNode;
}) {
  return (
    <Profiler id={`row:${props.item.id}`} onRender={instrument.onRender}>
      {props.renderItem({ item: props.item })}
    </Profiler>
  );
});

const enabled = NodeProcess.env.PAPERPLANE_RENDER_BENCH === "1";
const INPUTS = 40;
const REPEATS = 5;
const THREADS = 24;
const noop = () => {};
const environmentId = EnvironmentId.make("render-bench");
const timestamp = DateTime.makeUnsafe("2026-10-01T00:00:00Z");
const scenarios = [
  "background stream",
  "typing",
  "open stream",
  "switch threads",
  "provider-ready typing",
] as const;
type Scenario = (typeof scenarios)[number];
type Metric = { commits: number; actualMs: number };
// Leaves that must mount in the provider-ready scenario. Otherwise the
// provider-ready timing would measure the same no-provider path.
const providerReadyLeaves = [
  "leaf:ProviderModelPicker",
  "leaf:TraitsPicker",
  "leaf:CompactComposerControlsMenu",
  "leaf:ComposerPrimaryActions",
];

let MessagesTimeline: typeof import("./MessagesTimeline").MessagesTimeline;
let ChatComposer: typeof import("./ChatComposer").ChatComposer;
let ChatHeader: typeof import("./ChatHeader").ChatHeader;
let makeComposerProps: typeof import("./renderBenchFixtures").makeRenderBenchComposerProps;

function makeProjection(id: ThreadId): OrchestrationV2ThreadProjection {
  const base = makeThreadProjectionFixture();
  const fixture = makeStreamingTimelineFixture("");
  const visibleTurnItems = fixture.visibleTurnItems.map((row) => ({
    ...row,
    sourceThreadId: id,
    item: { ...row.item, threadId: id },
  }));
  return {
    ...base,
    thread: {
      ...base.thread,
      id,
      title: `Thread ${id}`,
      lineage: { ...base.thread.lineage, rootThreadId: id },
    },
    visibleTurnItems,
    turnItems: visibleTurnItems.map((row) => row.item),
  };
}

function makeHarness(providerReady: boolean) {
  const registry = AtomRegistry.make();
  const refs = Array.from({ length: THREADS }, (_, i) => ({
    environmentId,
    threadId: ThreadId.make(`bench-${i}`),
  }));
  const first = refs[0]!;
  const second = refs[1]!;
  const projections = new Map(refs.map((ref) => [ref.threadId, makeProjection(ref.threadId)]));
  const source = Atom.family((threadId: ThreadId) =>
    Atom.make(
      AsyncResult.success<EnvironmentThreadState>({
        data: Option.some(projections.get(threadId)!),
        status: "live",
        error: Option.none(),
        history: EMPTY_THREAD_HISTORY_META,
      }),
    ),
  );
  const details = createEnvironmentThreadDetailAtoms((_environmentId, threadId) =>
    source(threadId),
  );
  const rawShells: OrchestrationV2ThreadShell[] = refs.map(({ threadId }) => {
    const thread = projections.get(threadId)!.thread;
    return {
      ...thread,
      latestRunId: null,
      activeRunId: null,
      status: "running",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 6,
      visibleItemCount: 6,
    };
  });
  const snapshot = Atom.make<OrchestrationV2ShellSnapshot | null>({
    schemaVersion: 1,
    snapshotSequence: 0,
    projects: [],
    threads: rawShells,
    archivedThreads: [],
  });
  const catalog = Atom.make({
    isReady: true,
    entries: new Map([
      [
        environmentId,
        {
          target: new PrimaryConnectionTarget({
            environmentId,
            label: "Bench",
            httpBaseUrl: "http://bench.test",
            wsBaseUrl: "ws://bench.test",
          }),
          profile: Option.none(),
          enabled: true,
        },
      ],
    ]),
  });
  const shells = createEnvironmentThreadShellAtoms({
    catalogValueAtom: catalog,
    snapshotAtom: () => snapshot,
  });
  const selected = Atom.make(first);
  const composerProps = new Map(
    refs.map((ref) => [ref.threadId, makeComposerProps(ref, { providerReady })]),
  );
  const notifications: Record<string, number> = {};
  const identities: Record<string, number> = {};
  const disposers: Array<() => void> = [];
  function observe<A>(name: string, atom: Atom.Atom<A>) {
    let previous = registry.get(atom);
    notifications[name] = 0;
    identities[name] = 0;
    disposers.push(
      registry.subscribe(atom, (value) => {
        notifications[name]! += 1;
        if (!Object.is(previous, value)) identities[name]! += 1;
        previous = value;
      }),
    );
  }
  observe("shell list (Sidebar)", shells.threadShellsAtom);
  observe("thread refs", shells.threadRefsAtom);
  observe("active projection (ChatView)", details.threadAtom(first));
  observe("active visible items", details.visibleTurnItemsAtom(first));
  observe("background projection", details.threadAtom(second));
  observe("queue", details.queueWorkflowAtom(first));
  observe("requests", details.pendingRequestsAtom(first));
  refs.forEach((ref) => observe(`shell:${ref.threadId}`, shells.threadShellAtom(ref)));
  let drafts = useComposerDraftStore.getState().draftsByThreadKey;
  let serializedDrafts = JSON.stringify(drafts);
  notifications["draft store"] = 0;
  notifications["semantically unchanged draft writes"] = 0;
  identities["raw draft map identity"] = 0;
  disposers.push(
    useComposerDraftStore.subscribe((state) => {
      notifications["draft store"]! += 1;
      // Fixtures contain only text and empty attachment arrays, so JSON is an
      // exact semantic comparison here. It is outside Profiler render timing.
      const nextSerialized = JSON.stringify(state.draftsByThreadKey);
      if (serializedDrafts === nextSerialized) {
        notifications["semantically unchanged draft writes"]! += 1;
      }
      serializedDrafts = nextSerialized;
      if (drafts !== state.draftsByThreadKey) identities["raw draft map identity"]! += 1;
      drafts = state.draftsByThreadKey;
    }),
  );
  let panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, first);
  identities["right panel selection"] = 0;
  disposers.push(
    useRightPanelStore.subscribe((state) => {
      const next = selectThreadRightPanelState(state.byThreadKey, first);
      if (next !== panel) identities["right panel selection"]! += 1;
      panel = next;
    }),
  );

  function Owner() {
    instrument.ownerRenders++;
    const ref = useAtomValue(selected);
    // Same broad detail subscription as ChatView, not its render body.
    const thread = useAtomValue(details.threadAtom(ref));
    const { turnDiffSummaries } = useTurnDiffSummaries(thread?.projection ?? null);
    const previousSummaries = useRef(turnDiffSummaries);
    if (previousSummaries.current !== turnDiffSummaries) {
      identities["turn diff summaries"] = (identities["turn diff summaries"] ?? 0) + 1;
      previousSummaries.current = turnDiffSummaries;
    }
    const visibleTurnItems = useAtomValue(details.visibleTurnItemsAtom(ref));
    const shell = useAtomValue(shells.threadShellAtom(ref));
    const previous = useRef<{ threadId: ThreadId; value: TimelineEntriesProjection } | null>(null);
    const entries = useMemo(() => {
      const value = deriveTimelineEntriesFromVisibleTurnItemsWithState(
        { visibleTurnItems, optimisticMessages: [] },
        previous.current?.threadId === ref.threadId ? previous.current.value : null,
      );
      previous.current = { threadId: ref.threadId, value };
      return value.entries;
    }, [visibleTurnItems, ref.threadId]);
    const timelineProps = useMemo(
      () =>
        ({
          listRef: createRef<import("@legendapp/list/react").LegendListRef>(),
          isWorking: true,
          activeTurnInProgress: true,
          latestRun: null,
          runs: [],
          onOpenTurnDiff: noop,
          onOpenThread: noop,
          onForkFromRun: async () => {},
          onRollbackCheckpoint: noop,
          supportsConversationRollback: false,
          onRevertToTurnCount: noop,
          isRevertingCheckpoint: false,
          onImageExpand: noop,
          activeThreadEnvironmentId: environmentId,
          markdownCwd: undefined,
          resolvedTheme: "dark",
          timestampFormat: "locale",
          workspaceRoot: undefined,
          providerStatuses: [],
          anchorMessageId: null,
          onAnchorReady: noop,
          onAnchorSizeChanged: noop,
          contentInsetEndAdjustment: 0,
          onIsAtEndChange: noop,
          liveFollowEnabled: true,
          onManualNavigation: noop,
        }) satisfies Omit<
          ComponentProps<typeof MessagesTimeline>,
          "timelineEntries" | "routeThreadKey" | "turnDiffSummaries"
        >,
      [],
    );
    return (
      <>
        <Profiler id="header" onRender={instrument.onRender}>
          <ChatHeader
            activeThreadEnvironmentId={environmentId}
            activeThreadId={ref.threadId}
            activeThreadTitle={shell?.title ?? "Thread"}
            isServerThread
            activeProject={null}
            parentThreadLink={null}
            onOpenThread={noop}
            rightPanelOpen={false}
            onNewThreadInProject={noop}
          />
        </Profiler>
        <Profiler id="timeline" onRender={instrument.onRender}>
          <MessagesTimeline
            {...timelineProps}
            turnDiffSummaries={turnDiffSummaries}
            timelineEntries={entries}
            routeThreadKey={`${environmentId}:${ref.threadId}`}
          />
        </Profiler>
        <Profiler id="composer" onRender={instrument.onRender}>
          <ChatComposer {...composerProps.get(ref.threadId)!} />
        </Profiler>
      </>
    );
  }
  let sequence = 0;
  function append(ref: ScopedThreadRef) {
    const projection = projections.get(ref.threadId)!;
    const item = projection.turnItems.find(
      (candidate) => candidate.id === TurnItemId.make("live-assistant-item"),
    );
    if (item?.type !== "assistant_message") throw new Error("Missing streaming fixture");
    const next = applyOrchestrationV2TextAppend(projection, {
      kind: "text-append",
      sequence: ++sequence,
      threadId: ref.threadId,
      entity: { type: "turn-item", id: item.id },
      offset: item.text.length,
      append: " The client applies a streamed delta.",
      occurredAt: timestamp,
      updatedAt: timestamp,
    });
    if (next === null) throw new Error("Text delta was rejected");
    projections.set(ref.threadId, next);
    registry.set(
      source(ref.threadId),
      AsyncResult.success({
        data: Option.some(next),
        status: "live",
        error: Option.none(),
        history: EMPTY_THREAD_HISTORY_META,
      }),
    );
    // ProjectionStore emits no message preview in shells. ShellStream suppresses
    // timestamp-only updates for five seconds. Token pushes are detail-only.
  }
  return {
    registry,
    Owner,
    notifications,
    identities,
    input(scenario: Scenario, index: number) {
      if (scenario === "background stream") {
        append(second);
        // Simulate one timestamp refresh in a 40-frame burst. This is separate
        // from text and must not turn into a shell update for every token.
        if (index === 0) {
          const before = registry.get(snapshot)!;
          const shell = before.threads.find((thread) => thread.id === second.threadId)!;
          registry.set(
            snapshot,
            applyShellStreamEvent(before, {
              kind: "thread.updated",
              location: "active",
              sequence,
              thread: { ...shell, updatedAt: timestamp },
            }),
          );
        }
      } else if (scenario === "open stream") append(first);
      else if (scenario === "switch threads")
        registry.set(selected, index % 2 === 0 ? second : first);
      else {
        const text = "a".repeat(index + 2);
        if (instrument.editor === null) throw new Error("Editor did not mount");
        instrument.editor.onChange(text, text.length, text.length, false, []);
      }
    },
    reset() {
      Object.keys(notifications).forEach((key) => {
        notifications[key] = 0;
      });
      Object.keys(identities).forEach((key) => {
        identities[key] = 0;
      });
    },
    checkSwitch(index: number, container: HTMLElement) {
      const ref = index % 2 === 0 ? second : first;
      expect(container.textContent).toContain(`Thread ${ref.threadId}`);
      expect(instrument.editor?.value).toBe(index % 2 === 0 ? "" : "a");
    },
    check(scenario: Scenario, container: HTMLElement) {
      if (scenario === "typing" || scenario === "provider-ready typing") {
        expect(useComposerDraftStore.getState().getComposerDraft(first)?.prompt).toBe(
          "a".repeat(INPUTS + 1),
        );
        expect(container.querySelector("textarea")?.value).toBe("a".repeat(INPUTS + 1));
      } else if (scenario !== "switch threads") {
        const ref = scenario === "open stream" ? first : second;
        const last = projections.get(ref.threadId)!.turnItems.at(-1);
        expect(last?.type === "assistant_message" ? last.text : null).toBe(
          " The client applies a streamed delta.".repeat(INPUTS),
        );
        if (scenario === "open stream")
          expect(container.textContent).toContain("The client applies a streamed delta.");
      } else expect(registry.get(selected)).toBe(first);
    },
    dispose() {
      disposers.forEach((dispose) => dispose());
      registry.dispose();
    },
  };
}

type Sample = {
  scenario: Scenario;
  mountedLeaves: string[];
  groups: Record<string, Metric>;
  notifications: Record<string, number>;
  identities: Record<string, number>;
  ownerRenders: number;
  editorRenders: number;
};
const samples: Sample[] = [];

function summarize(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)]!, min: sorted[0]!, max: sorted.at(-1)! };
}

function report() {
  const summary = scenarios.map((scenario) => {
    const matching = samples.filter((sample) => sample.scenario === scenario);
    const first = matching[0]!;
    return {
      scenario,
      mountedLeaves: first.mountedLeaves,
      ownerRenders: summarize(matching.map((sample) => sample.ownerRenders)),
      editorRenders: summarize(matching.map((sample) => sample.editorRenders)),
      groups: Object.fromEntries(
        Object.keys(first.groups).map((id) => [
          id,
          {
            commits: summarize(matching.map((sample) => sample.groups[id]?.commits ?? 0)),
            actualMs: summarize(matching.map((sample) => sample.groups[id]?.actualMs ?? 0)),
          },
        ]),
      ),
      notifications: first.notifications,
      identities: first.identities,
    };
  });
  // Inspect the functions actually loaded by Vitest, rather than assume the
  // production compiler preset also transforms this test environment.
  const compilerCache = /\$\[\d+\]/;
  NodeProcess.stdout.write(
    `\nROVE_RENDER_SUMMARY ${JSON.stringify({
      inputs: INPUTS,
      threads: THREADS,
      repeats: REPEATS,
      timelineCompilerCacheDetected: compilerCache.test(MessagesTimeline.toString()),
      summary,
    })}\n`,
  );
  if (NodeProcess.env.PAPERPLANE_RENDER_BENCH_JSON === "1") {
    NodeProcess.stdout.write(`PAPERPLANE_RENDER_BASELINE ${JSON.stringify(samples)}\n`);
  }
}

describe.skipIf(!enabled)("render waste baseline (five warmed repetitions)", () => {
  beforeAll(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(document, "fonts", { configurable: true, value: new EventTarget() });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    window.matchMedia = (media) => ({
      matches: false,
      media,
      onchange: null,
      addListener: noop,
      removeListener: noop,
      addEventListener: noop,
      removeEventListener: noop,
      dispatchEvent: () => false,
    });
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ],
    });
    ({ MessagesTimeline } = await import("./MessagesTimeline"));
    ({ ChatComposer } = await import("./ChatComposer"));
    ({ ChatHeader } = await import("./ChatHeader"));
    ({ makeRenderBenchComposerProps: makeComposerProps } = await import("./renderBenchFixtures"));
  }, 120_000);

  afterAll(() => {
    Reflect.deleteProperty(document, "fonts");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("measures real committed render work and store fanout", async () => {
    const initialDraftState = useComposerDraftStore.getState();
    try {
      // Repeat zero warms modules/JIT/Markdown. Interleave scenarios to reduce drift.
      for (let repeat = 0; repeat <= REPEATS; repeat++) {
        for (const scenario of scenarios) {
          useComposerDraftStore.setState(initialDraftState, true);
          const providerReady = scenario === "provider-ready typing";
          const harness = makeHarness(providerReady);
          const container = document.createElement("div");
          document.body.append(container);
          const root = createRoot(container);
          const router = createRouter({
            routeTree: createRootRoute(),
            history: createMemoryHistory(),
          });
          const groups: Record<string, Metric> = {};
          instrument.onRender = (id, _phase, actualMs) => {
            const group = (groups[id] ??= { commits: 0, actualMs: 0 });
            group.commits++;
            group.actualMs += actualMs;
          };
          try {
            await act(async () =>
              root.render(
                <RegistryContext.Provider value={harness.registry}>
                  <RouterContextProvider router={router}>
                    <Profiler id="mounted root" onRender={instrument.onRender}>
                      <harness.Owner />
                    </Profiler>
                  </RouterContextProvider>
                </RegistryContext.Provider>,
              ),
            );
            // Leaves that mounted and committed during the initial render.
            const mountedLeaves = Object.keys(groups).filter((key) => key.startsWith("leaf:"));
            if (providerReady) {
              expect(mountedLeaves.toSorted()).toEqual(providerReadyLeaves.toSorted());
            } else {
              // Send actions do not depend on a provider; picker, traits and menu do.
              expect(mountedLeaves).toEqual(["leaf:ComposerPrimaryActions"]);
            }
            // Start with a non-empty draft so first-character visibility is not
            // mixed into the steady typing result. Mount effects are excluded.
            await act(async () =>
              useComposerDraftStore
                .getState()
                .setPrompt({ environmentId, threadId: ThreadId.make("bench-0") }, "a"),
            );
            Object.keys(groups).forEach((key) => {
              groups[key] = { commits: 0, actualMs: 0 };
            });
            harness.reset();
            instrument.ownerRenders = 0;
            instrument.editorRenders = 0;
            for (let input = 0; input < INPUTS; input++) {
              await act(async () => harness.input(scenario, input));
              if (scenario === "switch threads") harness.checkSwitch(input, container);
            }
            harness.check(scenario, container);
            if (repeat > 0)
              samples.push({
                scenario,
                mountedLeaves,
                groups,
                notifications: { ...harness.notifications },
                identities: { ...harness.identities },
                ownerRenders: instrument.ownerRenders,
                editorRenders: instrument.editorRenders,
              });
          } finally {
            await act(async () => root.unmount());
            harness.dispose();
            container.remove();
            instrument.editor = null;
            vi.clearAllTimers();
          }
        }
      }
      expect(samples).toHaveLength(REPEATS * scenarios.length);
      report();
    } finally {
      useComposerDraftStore.setState(initialDraftState, true);
    }
  }, 120_000);
});
