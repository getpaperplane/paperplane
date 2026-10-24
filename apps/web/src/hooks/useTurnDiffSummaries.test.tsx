import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  NodeId,
  RunId,
  type OrchestrationV2ThreadProjection,
} from "@getpaperplane/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeThreadProjectionFixture } from "../test-fixtures";
import { useTurnDiffSummaries } from "./useTurnDiffSummaries";

let renderer: ReactTestRenderer | null = null;
let observed: Array<ReturnType<typeof useTurnDiffSummaries>["turnDiffSummaries"]> = [];

function Probe({ projection }: { projection: OrchestrationV2ThreadProjection }) {
  observed.push(useTurnDiffSummaries(projection).turnDiffSummaries);
  return null;
}

async function render(projection: OrchestrationV2ThreadProjection) {
  await act(() => {
    if (renderer) renderer.update(<Probe projection={projection} />);
    else renderer = create(<Probe projection={projection} />);
  });
}

beforeEach(() => {
  observed = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

function checkpointProjection(): OrchestrationV2ThreadProjection {
  const base = makeThreadProjectionFixture();
  const runId = RunId.make("run");
  const nodeId = NodeId.make("node");
  return {
    ...base,
    messages: [
      {
        id: MessageId.make("assistant"),
        threadId: base.thread.id,
        runId,
        nodeId,
        role: "assistant",
        text: "Working",
        attachments: [],
        streaming: true,
        createdAt: base.updatedAt,
        updatedAt: base.updatedAt,
        createdBy: "agent",
        creationSource: "web",
      },
    ],
    checkpoints: [
      {
        id: CheckpointId.make("checkpoint"),
        threadId: base.thread.id,
        scopeId: CheckpointScopeId.make("scope"),
        runId,
        nodeId,
        parentCheckpointId: null,
        ordinalWithinScope: 0,
        appRunOrdinal: 1,
        ref: CheckpointRef.make("refs/paperplane/checkpoints/1"),
        status: "ready",
        files: [{ path: "src/app.ts", kind: "modified", additions: 3, deletions: 1 }],
        capturedAt: base.updatedAt,
      },
    ],
  };
}

describe("useTurnDiffSummaries", () => {
  it("keeps nonempty summaries stable across message-only streaming updates", async () => {
    const base = checkpointProjection();
    await render(base);
    expect(observed[0]).toHaveLength(1);
    expect(observed[0]?.[0]).toMatchObject({
      assistantMessageId: MessageId.make("assistant"),
      files: [{ path: "src/app.ts", kind: "modified", additions: 3, deletions: 1 }],
    });
    for (const text of ["Working on", "Working on the fix", "Finished"]) {
      await render({
        ...base,
        messages: base.messages.map((message) => ({ ...message, text })),
      });
      expect(observed.at(-1)).toBe(observed[0]);
    }
  });

  it("updates summary content and reference when checkpoint files change", async () => {
    const base = checkpointProjection();
    await render(base);
    await render({
      ...base,
      checkpoints: base.checkpoints.map((checkpoint) => ({
        ...checkpoint,
        files: [{ path: "src/app.ts", kind: "modified", additions: 7, deletions: 2 }],
      })),
    });
    expect(observed[1]).not.toBe(observed[0]);
    expect(observed[1]?.[0]?.files).toEqual([
      { path: "src/app.ts", kind: "modified", additions: 7, deletions: 2 },
    ]);
    expect(observed[0]?.[0]?.files[0]?.additions).toBe(3);
  });

  it("updates the assistant association when a later assistant message arrives", async () => {
    const base = checkpointProjection();
    await render(base);
    await render({
      ...base,
      messages: [...base.messages, { ...base.messages[0]!, id: MessageId.make("later-assistant") }],
    });
    expect(observed[1]).not.toBe(observed[0]);
    expect(observed[1]?.[0]?.assistantMessageId).toBe(MessageId.make("later-assistant"));
  });
});
