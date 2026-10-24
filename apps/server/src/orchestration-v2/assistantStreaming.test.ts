import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
} from "@getpaperplane/contracts";
import * as DateTime from "effect/DateTime";
import { makeAssistantStreamingFilter, splitBufferedAssistantText } from "./assistantStreaming.ts";
import type * as ProviderAdapter from "@getpaperplane/provider-core/server/ProviderAdapter";

const message = (text: string, streaming = true): ProviderAdapter.ProviderAdapterV2Event => ({
  type: "message.updated",
  driver: ProviderDriverKind.make("codex"),
  message: {
    id: MessageId.make("message"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    createdBy: "agent",
    creationSource: "provider",
    updatedAt: DateTime.makeUnsafe("2026-09-14T00:00:00Z"),
    role: "assistant",
    text,
    attachments: [],
    createdAt: DateTime.makeUnsafe("2026-09-14T00:00:00Z"),
    streaming,
  },
});

const turnItem = (
  text: string,
  streaming = true,
  type: "assistant_message" | "reasoning" = "assistant_message",
): ProviderAdapter.ProviderAdapterV2Event => ({
  type: "turn_item.updated",
  driver: ProviderDriverKind.make("codex"),
  turnItem: {
    id: TurnItemId.make("item"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: streaming ? "running" : "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-14T00:00:00Z"),
    ...(type === "assistant_message" ? { type, messageId: MessageId.make("message") } : { type }),
    text,
    streaming,
  },
});

describe("V2 assistant streaming", () => {
  it("delivers completed paragraphs, coalesces rapid updates, and flushes final text", () => {
    const filter = makeAssistantStreamingFilter("paragraph");
    expect(filter(message("First"), 0)).toBeNull();
    expect(filter(message("First\n\nSec"), 10)).toBeNull();
    expect(filter(message("First\n\nSec"), 400)).toMatchObject({ message: { text: "First\n\n" } });
    expect(filter(message("First\n\nSecond\n\nThi"), 500)).toBeNull();
    expect(filter(message("First\n\nSecond\n\nThird"), 800)).toMatchObject({
      message: { text: "First\n\nSecond\n\n" },
    });
    const final = message("First\n\nSecond\n\nThird", false);
    expect(filter(final, 810)).toBe(final);
  });
  it("throttles empty and unchanged boundaries, but never delays completion", () => {
    const filter = makeAssistantStreamingFilter("paragraph");
    expect(filter(message("```ts\nx()\n"), 0)).toBeNull();
    expect(filter(message("```ts\nx()\n```\n"), 50)).toBeNull();
    expect(filter(message("```ts\nx()\n```\n"), 400)).toMatchObject({
      message: { text: "```ts\nx()\n```\n" },
    });
    expect(filter(message("```ts\nx()\n```\nNext"), 800)).toBeNull();
    expect(filter(message("```ts\nx()\n```\nNext\n\n"), 850)).toBeNull();
    const final = message("```ts\nx()\n```\nNext\n\n", false);
    expect(filter(final, 851)).toBe(final);
    // Completion forgets both throttle and fence state for a reused item ID.
    expect(filter(message("Fresh\n\n"), 852)).toMatchObject({ message: { text: "Fresh\n\n" } });
  });

  it.each([
    "Intro\n\n```ts\nx()\n\n```\nAfter\n\nLast",
    "## Results\n\nBody\n\n**Next**\n\n~~~js\nx()\n~~~\nEnd",
    "- first\n- second\n  - nested\n1. ordered\n2) next\n\nTail",
    "    ```ts\nx\n        ```\ncontent\n     ```\nAfter\n\n",
    "```\nx\n```info\ny\n````\n\u00a0\n\nTail",
    "Intro\r\n \t\r\n## Title\r\n\r\nBody\r\n\r\nTail",
  ])("incremental boundaries match a fresh scan for every prefix of %j", (text) => {
    const filter = makeAssistantStreamingFilter("paragraph");
    let delivered = "";
    for (let length = 0; length <= text.length; length++) {
      const prefix = text.slice(0, length);
      const ready = splitBufferedAssistantText(prefix).ready;
      const event = filter(message(prefix), length * 400);
      if (ready && ready !== delivered) {
        expect(event).toMatchObject({ message: { text: ready } });
        delivered = ready;
      } else {
        expect(event).toBeNull();
      }
    }
  });

  it("rescans corrected and shortened snapshots rather than retaining obsolete fence state", () => {
    const filter = makeAssistantStreamingFilter("paragraph");
    expect(filter(message("Intro\n\n```ts\nx\n"), 0)).toMatchObject({
      message: { text: "Intro\n\n" },
    });
    expect(filter(message("New\n\nTail"), 400)).toMatchObject({ message: { text: "New\n\n" } });
    expect(filter(message("New\n"), 800)).toBeNull();
    expect(filter(message("New\n\nFinal\n\n"), 1200)).toMatchObject({
      message: { text: "New\n\nFinal\n\n" },
    });
  });

  it("keeps message and reasoning scanners independent", () => {
    const filter = makeAssistantStreamingFilter("paragraph");
    expect(filter(message("```ts\nx\n"), 0)).toBeNull();
    expect(filter(turnItem("Reason\n\n", true, "reasoning"), 0)).toMatchObject({
      turnItem: { text: "Reason\n\n" },
    });
    expect(filter(message("```ts\nx\n```\n"), 400)).toMatchObject({
      message: { text: "```ts\nx\n```\n" },
    });
  });

  it("keeps code fences intact", () => {
    expect(splitBufferedAssistantText("Intro\n\n```ts\nx()\n\n")).toEqual({
      ready: "Intro\n\n",
      rest: "```ts\nx()\n\n",
    });
    expect(splitBufferedAssistantText("```ts\nx()\n```\nrest")).toEqual({
      ready: "```ts\nx()\n```\n",
      rest: "rest",
    });
  });
  it("holds streaming text until the full response completes", () => {
    const running = message("partial");
    const final = message("complete", false);
    const buffered = makeAssistantStreamingFilter("turn");
    expect(buffered(running, 0)).toBeNull();
    expect(buffered(message("First\n\nSecond\n\n"), 500)).toBeNull();
    expect(buffered(final, 501)).toBe(final);
  });

  it.each(["assistant_message", "reasoning"] as const)(
    "buffers %s at paragraph boundaries and flushes the final item",
    (type) => {
      const item = (text: string, streaming = true) => turnItem(text, streaming, type);
      const filter = makeAssistantStreamingFilter("paragraph");
      expect(filter(item("First"), 0)).toBeNull();
      expect(filter(item("First\n\nSec"), 10)).toBeNull();
      expect(filter(item("First\n\nSec"), 400)).toMatchObject({
        turnItem: { text: "First\n\n", streaming: true, type },
      });
      expect(filter(item("First\n\nSecond\n\nThi"), 500)).toBeNull();
      expect(filter(item("First\n\nSecond\n\nThi"), 800)).toMatchObject({
        turnItem: { text: "First\n\nSecond\n\n", streaming: true },
      });
      const final = item("First\n\nSecond\n\nThird", false);
      expect(filter(final, 810)).toBe(final);

      const buffered = makeAssistantStreamingFilter("turn");
      expect(buffered(item("First\n\nSecond"), 0)).toBeNull();
      expect(buffered(final, 1)).toBe(final);
    },
  );

  it.each(["turn", "paragraph"] as const)(
    "suppresses running assistant nodes in %s mode while delivering tool and completed nodes",
    (mode) => {
      const filter = makeAssistantStreamingFilter(mode);
      const running: Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "node.updated" }> = {
        type: "node.updated",
        driver: ProviderDriverKind.make("codex"),
        node: {
          id: NodeId.make("node"),
          threadId: ThreadId.make("thread"),
          runId: null,
          parentNodeId: null,
          rootNodeId: NodeId.make("root"),
          kind: "assistant_message",
          status: "running",
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: null,
          completedAt: null,
        },
      };
      expect(filter(running, 0)).toBeNull();
      const completed = { ...running, node: { ...running.node, status: "completed" as const } };
      expect(filter(completed, 1)).toBe(completed);
      const tool = { ...running, node: { ...running.node, kind: "tool_call" as const } };
      expect(filter(tool, 2)).toBe(tool);
    },
  );
});

it("holds a streamed section heading until its content has a boundary", () => {
  expect(splitBufferedAssistantText("Intro\n\n## Results\n\n")).toEqual({
    ready: "Intro\n\n",
    rest: "## Results\n\n",
  });
  expect(splitBufferedAssistantText("**Results**\n\nBody\n\nNext")).toEqual({
    ready: "**Results**\n\nBody\n\n",
    rest: "Next",
  });
});
