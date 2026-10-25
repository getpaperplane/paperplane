// @vitest-environment jsdom

// Streaming render benchmark. Opt-in because it is slow and prints a report:
//   PAPERPLANE_STREAMING_BENCH=1 vp test run src/components/chat/streamingRender.bench.test.tsx
// It mounts the real ChatMarkdown inside a React Profiler and streams a reply in
// 500 deltas, counting commits, render time, and Markdown parse work.

import { EnvironmentId, type AuthEnvironmentScope } from "@getpaperplane/contracts";
import { act, Profiler, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { unified } from "unified";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";

vi.mock("../../hooks/useFileMetadata", () => ({ useFileMetadata: () => null }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("./MermaidDiagram", () => ({ MermaidDiagram: () => <svg aria-label="Diagram" /> }));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("../ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("../ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/session")>();
  const { AuthStandardClientScopes } = await import("@getpaperplane/contracts");
  const grantedScopes = new Set<AuthEnvironmentScope>(AuthStandardClientScopes);
  const hasScope = (environmentId: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    environmentId !== null && grantedScopes.has(scope);
  return {
    ...actual,
    useEnvironmentScope: hasScope,
    readEnvironmentScope: hasScope,
    usePreparedConnection: () => ({ _tag: "Loading" }),
  };
});
vi.mock("../../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import { derivePendingThreadRequests } from "@getpaperplane/client-runtime/state/thread-requests";
import { memo, useMemo } from "react";
import * as DateTime from "effect/DateTime";

import { useStableCallback } from "../../hooks/useStableCallback";
import { useStructuralValue } from "../../hooks/useStructuralValue";
import { derivePendingApprovals, derivePendingUserInputs } from "../../session-logic";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import ChatMarkdown from "../ChatMarkdown";

const DELTAS = 500;
const TARGET_BYTES = 10_000;
const enabled = process.env.PAPERPLANE_STREAMING_BENCH === "1";

// Deterministic text so runs compare across commits.
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

const WORDS =
  "the server projection applies each event before the client renders a timeline row while the composer keeps its draft and streaming text arrives in small deltas that grow the reply".split(
    " ",
  );

function sentence(random: () => number): string {
  const length = 8 + Math.floor(random() * 12);
  const words = Array.from({ length }, () => WORDS[Math.floor(random() * WORDS.length)]!);
  if (random() < 0.3) words[2] = `\`${words[2]}\``;
  if (random() < 0.2) words[5] = `**${words[5]}**`;
  if (random() < 0.15) words[7] = `[${words[7]}](https://example.com/${words[7]})`;
  const text = words.join(" ");
  return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
}

function proseReply(): string {
  const random = seeded(7);
  const parts: string[] = [];
  let size = 0;
  for (let section = 1; size < TARGET_BYTES; section++) {
    const block =
      section % 4 === 0
        ? Array.from({ length: 4 }, () => `- ${sentence(random)}`).join("\n")
        : section % 5 === 0
          ? `## Section ${section}`
          : Array.from({ length: 3 }, () => sentence(random)).join(" ");
    parts.push(block);
    size += block.length + 2;
  }
  return parts.join("\n\n").slice(0, TARGET_BYTES);
}

function fencedReply(): string {
  const random = seeded(11);
  const parts: string[] = [];
  let size = 0;
  for (let section = 1; size < TARGET_BYTES; section++) {
    const block =
      section % 3 === 0
        ? [
            "```ts",
            ...Array.from(
              { length: 8 },
              (_, line) => `const value${line} = applyEvent(state, events[${line}]);`,
            ),
            "```",
          ].join("\n")
        : section % 7 === 0
          ? "| Step | Result |\n| --- | --- |\n| parse | ok |\n| render | ok |"
          : Array.from({ length: 2 }, () => sentence(random)).join(" ");
    parts.push(block);
    size += block.length + 2;
  }
  return parts.join("\n\n").slice(0, TARGET_BYTES);
}

/** Times every Markdown parse, including ones a block splitter runs, by wrapping unified. */
function measureParsing() {
  // SAFETY: every unified processor inherits `parse` from the Processor prototype.
  const prototype = Object.getPrototypeOf(unified()) as {
    parse: (this: unknown, ...args: unknown[]) => unknown;
  };
  const original = prototype.parse;
  const totals = { calls: 0, ms: 0 };
  prototype.parse = function (this: unknown, ...args: unknown[]) {
    const started = performance.now();
    try {
      return original.apply(this, args);
    } finally {
      totals.ms += performance.now() - started;
      totals.calls += 1;
    }
  };
  return { totals, restore: () => (prototype.parse = original) };
}

interface MarkdownStreamResult {
  readonly label: string;
  readonly commits: number;
  readonly actualMs: number;
  readonly wallMs: number;
  readonly parseCalls: number;
  readonly parseMs: number;
}

async function streamMarkdown(label: string, reply: string): Promise<MarkdownStreamResult> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let commits = 0;
  let actualMs = 0;
  const onRender: ComponentProps<typeof Profiler>["onRender"] = (_id, _phase, actual) => {
    commits += 1;
    actualMs += actual;
  };
  const render = (text: string, isStreaming: boolean) =>
    root.render(
      <Profiler id="ChatMarkdown" onRender={onRender}>
        <ChatMarkdown cwd="/tmp/project" text={text} isStreaming={isStreaming} />
      </Profiler>,
    );
  const parsing = measureParsing();
  const started = performance.now();
  for (let delta = 1; delta <= DELTAS; delta++) {
    const text = reply.slice(0, Math.ceil((reply.length * delta) / DELTAS));
    await act(async () => render(text, true));
  }
  await act(async () => render(reply, false));
  const wallMs = performance.now() - started;
  parsing.restore();
  await act(async () => root.unmount());
  container.remove();
  return {
    label,
    commits,
    actualMs,
    wallMs,
    parseCalls: parsing.totals.calls,
    parseMs: parsing.totals.ms,
  };
}

const results: MarkdownStreamResult[] = [];

// ChatView cannot mount in a unit test, so the composer section reproduces how
// ChatView derived the composer props that changed on every delta, before and
// after this change, from a projection rebuilt per delta as the reducer does.
type ProjectionMessages = ReadonlyArray<{ readonly id: string; readonly role: string }>;
const EMPTY_TASKS: readonly never[] = [];

let composerRenders = 0;
const ProbeComposer = memo(function ProbeComposer(_props: Record<string, unknown>) {
  composerRenders += 1;
  return null;
});

function ComposerPropsBefore(props: {
  projection: ReturnType<typeof makeThreadProjectionFixture>;
  messages: ProjectionMessages;
}) {
  const pendingRequests = useMemo(
    () => derivePendingThreadRequests(props.projection),
    [props.projection],
  );
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(pendingRequests.approvals),
    [pendingRequests.approvals],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(pendingRequests.userInputs),
    [pendingRequests.userInputs],
  );
  const backgroundTasks: ReadonlyArray<unknown> = [];
  const bannerItems = useMemo(() => [...backgroundTasks], [backgroundTasks]);
  return (
    <ProbeComposer
      promptHistoryMessages={props.messages}
      pendingApprovals={pendingApprovals}
      pendingUserInputs={pendingUserInputs}
      bannerItems={bannerItems}
    />
  );
}

function ComposerPropsAfter(props: {
  projection: ReturnType<typeof makeThreadProjectionFixture>;
  messages: ProjectionMessages;
}) {
  const pendingRequests = useMemo(
    () => derivePendingThreadRequests(props.projection),
    [props.projection],
  );
  const pendingApprovals = useStructuralValue(
    useMemo(() => derivePendingApprovals(pendingRequests.approvals), [pendingRequests.approvals]),
  );
  const pendingUserInputs = useStructuralValue(
    useMemo(
      () => derivePendingUserInputs(pendingRequests.userInputs),
      [pendingRequests.userInputs],
    ),
  );
  const getPromptHistoryMessages = useStableCallback(() => props.messages);
  const bannerItems = useMemo(() => [...EMPTY_TASKS], []);
  return (
    <ProbeComposer
      getPromptHistoryMessages={getPromptHistoryMessages}
      pendingApprovals={pendingApprovals}
      pendingUserInputs={pendingUserInputs}
      bannerItems={bannerItems}
    />
  );
}

/** Renders of the memoized composer while a reply streams. */
async function streamComposerProps(Harness: typeof ComposerPropsBefore): Promise<number> {
  const container = document.createElement("div");
  const root = createRoot(container);
  const base = makeThreadProjectionFixture();
  const user = { id: "user-1", role: "user" };
  composerRenders = 0;
  for (let delta = 1; delta <= DELTAS; delta++) {
    const projection = {
      ...base,
      updatedAt: DateTime.makeUnsafe(Date.UTC(2026, 0, 1, 0, 0, delta)),
    };
    const messages = [user, { id: "assistant-1", role: "assistant", text: "x".repeat(delta) }];
    await act(async () => root.render(<Harness projection={projection} messages={messages} />));
  }
  await act(async () => root.unmount());
  return composerRenders;
}

// Vitest buffers console output per test; the report goes straight to stdout.
function printTable(rows: ReadonlyArray<Record<string, string | number>>) {
  const columns = Object.keys(rows[0] ?? {});
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => String(row[column]).length)),
  );
  const line = (cells: ReadonlyArray<string>) =>
    `| ${cells.map((cell, index) => cell.padEnd(widths[index]!)).join(" | ")} |`;
  process.stdout.write(
    [
      "",
      line(columns),
      line(widths.map((width) => "-".repeat(width))),
      ...rows.map((row) => line(columns.map((column) => String(row[column])))),
      "",
    ].join("\n") + "\n",
  );
}

describe.skipIf(!enabled)("streaming render benchmark", () => {
  // Loading the highlighter takes seconds and would swamp the wall-clock column.
  beforeAll(async () => {
    await getSyntaxHighlighterPromise("typescript");
  });

  afterAll(() => {
    printTable(
      results.map((result) => ({
        reply: result.label,
        commits: result.commits,
        "render ms (Profiler)": Math.round(result.actualMs),
        "wall ms": Math.round(result.wallMs),
        "parse calls": result.parseCalls,
        "parse ms": Math.round(result.parseMs),
      })),
    );
  });

  it("re-renders the memoized composer only when its props change", async () => {
    const before = await streamComposerProps(ComposerPropsBefore);
    const after = await streamComposerProps(ComposerPropsAfter);
    printTable([
      { "ChatComposer renders per 500 deltas": "before", count: before },
      { "ChatComposer renders per 500 deltas": "after", count: after },
    ]);
    expect(after).toBeLessThan(before);
  });

  it("streams a 10 KB prose reply through ChatMarkdown", async () => {
    const result = await streamMarkdown("prose 10 KB", proseReply());
    results.push(result);
    expect(result.commits).toBeGreaterThan(0);
  });

  it("streams a 10 KB reply with code fences through ChatMarkdown", async () => {
    const result = await streamMarkdown("fenced 10 KB", fencedReply());
    results.push(result);
    expect(result.commits).toBeGreaterThan(0);
  });
});
