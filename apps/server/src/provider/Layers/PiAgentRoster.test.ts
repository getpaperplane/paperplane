import { describe, expect, it } from "vite-plus/test";

import type { PiAgentEntry } from "./PiAgentHook.ts";
import { PiAgentRoster, type PiAgentTaskDescriptor } from "./PiAgentRoster.ts";

function harness(
  replay: Record<string, PiAgentEntry[]> = {},
  isProcessAlive?: (pid: number) => boolean,
) {
  const tasks: PiAgentTaskDescriptor[] = [];
  const timers: Array<() => void> = [];
  const roster = new PiAgentRoster({
    emit: (_threadId, task) => tasks.push(task),
    schedule: (run) => {
      timers.push(run);
      return { cancel: () => timers.splice(timers.indexOf(run), 1) };
    },
    progressIntervalMs: 0,
    replay: (_threadId, agentId) => replay[agentId] ?? [],
    ...(isProcessAlive ? { isProcessAlive } : {}),
  });
  let sequence = 0;
  const entry = (a: string, k: PiAgentEntry["k"], fields: Partial<PiAgentEntry> = {}) =>
    ({ v: 1, a, th: "thread", w: 1, q: ++sequence, at: sequence, k, ...fields }) as PiAgentEntry;
  return {
    roster,
    tasks,
    entry,
    runTimers: () => {
      for (const run of timers.splice(0)) run();
    },
    statuses: (id: string) =>
      tasks
        .filter((task) => task.payload.taskId === id)
        .map((task) =>
          task.type === "task.completed"
            ? `completed:${task.payload.status}`
            : task.type === "task.updated"
              ? `updated:${task.payload.status}`
              : task.type,
        ),
  };
}

describe("PiAgentRoster", () => {
  it("hides an agent CLI that exits quickly without output", () => {
    const { roster, tasks, entry } = harness();
    roster.ingest(entry("cli", "start", { src: "cli", label: "claude", cmd: "claude --version" }));
    roster.ingest(entry("cli", "exit", { code: 0 }));
    expect(tasks).toEqual([]);
  });

  it("reveals an agent CLI once it produces output, and fails it on a non-zero exit", () => {
    const { roster, entry, statuses, tasks } = harness();
    roster.ingest(entry("cli", "start", { src: "cli", label: "codex", cmd: "codex exec fix" }));
    roster.ingest(entry("cli", "tool", { id: "1", name: "command", target: "ls" }));
    roster.ingest(entry("cli", "exit", { code: 2 }));
    expect(statuses("cli")).toEqual(["task.started", "task.progress", "completed:failed"]);
    expect(tasks.at(-1)?.payload).toMatchObject({ summary: "Exited with code 2." });
  });

  it("reopens a settled agent when it starts working again", () => {
    const { roster, entry, statuses } = harness();
    roster.ingest(entry("pi", "start", { src: "pi", parent: { th: "thread", t: "call" } }));
    roster.ingest(entry("pi", "busy"));
    roster.ingest(entry("pi", "idle"));
    roster.ingest(entry("pi", "busy"));
    roster.ingest(entry("pi", "text", { text: "boom", stop: "error", error: "Rate limited" }));
    roster.ingest(entry("pi", "idle"));
    expect(statuses("pi")).toEqual([
      "task.started",
      "task.progress",
      "completed:completed",
      "updated:running",
      "task.progress",
      "task.progress",
      "completed:failed",
    ]);
  });

  it("recovers a child's last entries from disk when its process exits first", () => {
    const { roster, entry, statuses, tasks } = harness({
      pi: [
        { v: 1, a: "pi", th: "thread", w: 2, q: 1, at: 1, k: "start", src: "pi" },
        {
          v: 1,
          a: "pi",
          th: "thread",
          w: 2,
          q: 2,
          at: 2,
          k: "text",
          text: "All done",
          stop: "stop",
        },
      ],
    });
    // Only the spawner's exit arrived over the channel.
    roster.ingest(entry("pi", "exit", { code: 0 }));
    expect(statuses("pi")).toEqual(["task.started", "task.progress", "completed:completed"]);
    expect(tasks.at(-1)?.payload).toMatchObject({ summary: "All done" });
  });

  it("reconciles a CLI after its spawner disappears without interrupting a live detached child", () => {
    let alive = true;
    const { roster, entry, statuses, runTimers } = harness({}, () => alive);
    roster.ingest(entry("cli", "start", { src: "cli", pid: 123 }));
    roster.ingest(entry("cli", "text", { text: "Reviewing" }));
    roster.channelClosed(["cli"]);
    runTimers();
    expect(statuses("cli").at(-1)).toBe("task.progress");
    alive = false;
    runTimers();
    runTimers();
    expect(statuses("cli").at(-1)).toBe("completed:failed");
  });

  it("replays terminal entries before reconciling a lost CLI channel", () => {
    const { roster, entry, statuses, runTimers } = harness(
      {
        cli: [{ v: 1, a: "cli", th: "thread", w: 2, q: 1, at: 1, k: "exit", code: 0 }],
      },
      () => false,
    );
    roster.ingest(entry("cli", "start", { src: "cli", pid: 123 }));
    roster.ingest(entry("cli", "text", { text: "Done" }));
    roster.channelClosed(["cli"]);
    runTimers();
    expect(statuses("cli").at(-1)).toBe("completed:completed");
  });

  it("retires only the owning thread and does not revive an exited agent", () => {
    const { roster, entry, statuses } = harness();
    roster.ingest(entry("child", "start", { src: "agent" }));
    roster.ingest(entry("other", "start", { src: "agent", th: "other-thread" }));
    roster.closeThread("thread");
    roster.ingest(entry("child", "busy"));
    expect(statuses("child").at(-1)).toBe("completed:stopped");
    expect(statuses("other").at(-1)).toBe("task.started");
  });

  it("fails an agent whose process vanished mid-run", () => {
    const { roster, entry, statuses, runTimers } = harness();
    roster.ingest(entry("pi", "start", { src: "pi" }));
    roster.ingest(entry("pi", "busy"));
    roster.channelClosed(["pi"]);
    runTimers();
    expect(statuses("pi").at(-1)).toBe("completed:failed");
  });
});
