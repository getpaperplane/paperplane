// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ThreadId } from "@rove-code/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { foldAgentTranscript } from "../../orchestration/agentTranscriptQuery.ts";
import type { PiCreateSessionInput, PiSessionLike } from "./PiAdapter.ts";
import { createPiSession } from "./PiSessionFactory.ts";
import {
  createPiSubagentTool,
  type PiAgentTaskDescriptor,
  type PiSubagentSession,
} from "./PiSubagents.ts";

describe("Rove subagents in Pi threads", () => {
  let root: string;
  let cwd: string;
  let transcripts: string;
  const sessions: PiSessionLike[] = [];

  beforeEach(() => {
    root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-pi-subagents-")),
    );
    cwd = NodePath.join(root, "project");
    transcripts = NodePath.join(root, "transcripts");
    const agentDir = NodePath.join(root, "agent");
    NodeFS.mkdirSync(NodePath.join(cwd, ".pi", "extensions"), { recursive: true });
    NodeFS.mkdirSync(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_OFFLINE", "1");
    NodeFS.copyFileSync(
      new URL("./fixtures/pi-subagent-extension.ts", import.meta.url),
      NodePath.join(cwd, ".pi", "extensions", "fixture.ts"),
    );
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.dispose();
    vi.unstubAllEnvs();
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  const run = async (
    subagents: boolean,
    options?: {
      subagents?: PiCreateSessionInput["subagents"];
      thinkingLevel?: string;
      currentThinkingLevel?: string;
      reportSelection?: boolean;
    },
  ) => {
    const threadId = ThreadId.make("pi-subagents");
    const tasks: PiAgentTaskDescriptor[] = [];
    const session = await createPiSession(
      {
        threadId,
        cwd,
        model: options?.reportSelection
          ? "rove-subagent-test/reasoning"
          : "rove-subagent-test/fixture",
        thinkingLevel: options?.thinkingLevel,
        resumeSessionId: undefined,
        ...(subagents ? { subagents: options?.subagents ?? {} } : undefined),
      },
      { onSubagentTask: (task) => tasks.push(task), subagentTranscriptsRoot: transcripts },
    );
    sessions.push(session);
    if (options?.currentThinkingLevel !== undefined) {
      await session.setThinkingLevel?.(options.currentThinkingLevel);
    }
    await session.prompt(options?.reportSelection ? "delegate and report session" : "delegate");
    const reply = JSON.stringify(session.messages.at(-1));
    return { threadId, tasks, reply, session };
  };

  it("runs a subagent as a sterile child session and reports its lifecycle", async () => {
    const { threadId, tasks, reply } = await run(true);

    expect(reply).toContain("parent got: child report");
    expect(tasks.map((task) => task.type)).toEqual(
      expect.arrayContaining(["task.started", "task.completed"]),
    );
    const completed = tasks.find((task) => task.type === "task.completed");
    expect(completed?.payload).toMatchObject({
      status: "completed",
      title: "Inspect the repo",
      summary: "child report",
      model: "rove-subagent-test/fixture",
      toolUseId: "delegate-1",
      runHandles: { hasTranscript: true },
    });

    const taskId = completed!.payload.taskId;
    const lines = NodeFS.readFileSync(
      NodePath.join(transcripts, threadId, `${taskId}.jsonl`),
      "utf8",
    ).split("\n");
    expect(foldAgentTranscript(lines, false)).toMatchObject({
      model: "rove-subagent-test/fixture",
      cwd,
      entries: [
        { kind: "task", text: "inspect" },
        { kind: "text", text: "child report" },
      ],
    });
  });

  it.each([undefined, null])(
    "inherits the parent's current thinking when override is %s",
    async (thinkingLevel) => {
      const { tasks, reply, session } = await run(true, {
        thinkingLevel: "high",
        currentThinkingLevel: "low",
        subagents: { thinkingLevel },
        reportSelection: true,
      });
      expect(reply).toContain("child selection: reasoning/low");
      expect(session.getThinkingLevel?.()).toBe("low");
      expect(tasks.find((task) => task.type === "task.completed")?.payload).toMatchObject({
        effort: "low",
      });
    },
  );

  it.each([
    { parent: "low", child: "high" as const },
    { parent: "high", child: "off" as const },
  ])(
    "runs the child with $child thinking without changing parent $parent",
    async ({ parent, child }) => {
      const { tasks, reply, session } = await run(true, {
        thinkingLevel: parent,
        subagents: { thinkingLevel: child },
        reportSelection: true,
      });
      expect(reply).toContain(`child selection: reasoning/${child}`);
      expect(session.getThinkingLevel?.()).toBe(parent);
      expect(tasks.find((task) => task.type === "task.completed")?.payload).toMatchObject({
        effort: child,
      });
    },
  );

  it("clamps thinking to the overridden child model and reports the effective level", async () => {
    const { tasks, reply, session } = await run(true, {
      thinkingLevel: "low",
      subagents: { model: "rove-subagent-test/fixture", thinkingLevel: "high" },
      reportSelection: true,
    });
    expect(reply).toContain("child selection: fixture/off");
    expect(session.getThinkingLevel?.()).toBe("low");
    expect(tasks.find((task) => task.type === "task.completed")?.payload).toMatchObject({
      model: "rove-subagent-test/fixture",
      effort: "off",
    });
  });

  it("leaves the tool out when subagents are off", async () => {
    const { tasks, reply } = await run(false);
    expect(reply).toContain("no subagent tool");
    expect(tasks).toEqual([]);
  });
});

describe("createPiSubagentTool", () => {
  const context = {
    cwd: "/workspace",
    model: undefined,
    thinkingLevel: "low",
  } as unknown as Parameters<ToolDefinition["execute"]>[4];

  /** A child that runs until aborted, or fails when `fail` is set. */
  const fakeChild = (fail?: string) => {
    let listener: ((event: { type: string } & Record<string, unknown>) => void) | undefined;
    let finish: (() => void) | undefined;
    const end = (stopReason: string, errorMessage?: string) => {
      listener?.({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason, errorMessage },
      });
      finish?.();
    };
    const session: PiSubagentSession = {
      subscribe: (next) => {
        listener = next;
        return () => undefined;
      },
      prompt: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
          if (fail) end("error", fail);
        }),
      abort: async () => end("aborted"),
      dispose: () => undefined,
      getLastAssistantText: () => undefined,
    };
    return session;
  };

  const setup = (session: PiSubagentSession) => {
    const tasks: PiAgentTaskDescriptor[] = [];
    const subagents = createPiSubagentTool({
      threadId: "thread-1",
      transcriptsRoot: undefined,
      emit: (task) => tasks.push(task),
      startSession: async () => ({ session, model: "test/model" }),
    });
    return { tasks, subagents };
  };

  it("settles as stopped when the thread stops the tool call", async () => {
    const { tasks, subagents } = setup(fakeChild());
    const controller = new AbortController();
    const running = subagents.tool.execute(
      "call-1",
      { prompt: "work" },
      controller.signal,
      undefined,
      context,
    );
    await vi.waitFor(() => expect(tasks[0]?.type).toBe("task.started"));
    controller.abort();
    await expect(running).rejects.toThrow("Subagent was stopped.");
    expect(tasks.at(-1)).toMatchObject({
      type: "task.completed",
      payload: { status: "stopped", effort: "low", model: "test/model" },
    });
  });

  it("stops running children when the thread session is disposed", async () => {
    const { tasks, subagents } = setup(fakeChild());
    const running = subagents.tool.execute(
      "call-1",
      { prompt: "work" },
      undefined,
      undefined,
      context,
    );
    await vi.waitFor(() => expect(tasks[0]?.type).toBe("task.started"));
    await subagents.dispose();
    await expect(running).rejects.toThrow("Subagent was stopped.");
    expect(tasks.at(-1)?.payload).toMatchObject({ status: "stopped" });
  });

  it("fails the tool call with the child's error", async () => {
    const { tasks, subagents } = setup(fakeChild("model unavailable"));
    await expect(
      subagents.tool.execute("call-1", { prompt: "work" }, undefined, undefined, context),
    ).rejects.toThrow("model unavailable");
    expect(tasks.at(-1)?.payload).toMatchObject({
      status: "failed",
      summary: "model unavailable",
    });
  });
});
