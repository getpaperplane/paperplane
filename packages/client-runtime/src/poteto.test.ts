import { CommandId, EventId, type OrchestrationThreadActivity } from "@rove-code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveThreadPotetoView,
  POTETO_PROJECT_SPEC_EXAMPLE,
  validatePotetoProjectSpecJson,
} from "./poteto.ts";

const progress = (runId: string, phase: string, status = "running") => ({
  runId: CommandId.make(runId),
  attemptId: CommandId.make(`${runId}-attempt`),
  status,
  phase,
  reason: null,
});

function activity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    kind,
    payload,
    tone: "info",
    summary: kind,
    turnId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("Poteto client helpers", () => {
  it("accepts the included pilot spec and reports useful schema errors", () => {
    expect(validatePotetoProjectSpecJson(POTETO_PROJECT_SPEC_EXAMPLE).valid).toBe(true);

    const invalid = validatePotetoProjectSpecJson(
      JSON.stringify({
        task: "Change one thing",
        editableFiles: ["../outside.ts"],
        contextFiles: [],
        check: {
          module: "other.ts",
          export: "value",
          cases: [{ args: [], expected: 1 }],
        },
      }),
    );
    expect(invalid).toMatchObject({ valid: false });
    if (!invalid.valid) {
      expect(invalid.errors).toContain(
        "File scope must use literal, repo-relative paths without traversal or .git.",
      );
      expect(invalid.errors).toContain(
        "Check module must be included in editable or context files.",
      );
    }
  });

  it("waits for a durable finished row after cancellation and across retries", () => {
    const cancelled = activity("cancel", "poteto.control", {
      progress: progress("run", "review", "cancelled"),
    });
    expect(deriveThreadPotetoView([cancelled]).pending).toBe(true);
    const finished = activity("finished", "poteto.finished", {
      progress: progress("run", "review", "cancelled"),
    });
    expect(deriveThreadPotetoView([cancelled, finished]).pending).toBe(false);
    const retry = activity("retry", "poteto.requested", {
      progress: { ...progress("run", "reproduce", "requested"), attemptId: "retry-attempt" },
    });
    expect(deriveThreadPotetoView([cancelled, finished, retry]).pending).toBe(true);
    expect(deriveThreadPotetoView([])).toMatchObject({ progress: null, pending: false });
  });

  it("keeps reports for only the latest run and drops file snapshots from artifacts", () => {
    const view = deriveThreadPotetoView([
      activity("old", "poteto.event", {
        progress: progress("run-old", "implement", "running"),
        artifact: { result: { summary: "Old report" } },
      }),
      activity("evidence", "poteto.event", {
        progress: progress("run-new", "investigate"),
        artifact: {
          type: "accepted",
          phase: "reproduce",
          result: { id: "reproduction", outcome: "fail", output: "The original case failed." },
          files: [{ path: "private.ts", content: "secret" }],
        },
      }),
      activity("latest", "poteto.finished", {
        progress: progress("run-new", "review", "blocked"),
      }),
    ]);

    expect(view.progress).toMatchObject({ runId: "run-new", status: "blocked", phase: "review" });
    expect(view.artifacts).toHaveLength(1);
    expect(view.artifacts[0]?.phase).toBe("reproduce");
    expect(JSON.stringify(view.artifacts)).toContain("The original case failed.");
    expect(JSON.stringify(view.artifacts)).not.toContain("private.ts");
    expect(JSON.stringify(view.artifacts)).not.toContain("secret");
  });
});
