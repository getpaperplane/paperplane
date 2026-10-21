import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@rove-code/contracts";
import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";
import { PI_COMPACTION_MARKER } from "./input.ts";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** SDK compaction refusal is a failed run; success leaves context unknown until the next model call. */
export function assertPiCompactionOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const calls = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" ? [entry.frame] : [],
  );
  assert.lengthOf(
    calls.filter((frame) => field(frame, "method") === "compact"),
    2,
  );
  assert.isFalse(
    calls.some((frame) => {
      const args = field(frame, "args");
      return (
        field(frame, "method") === "prompt" &&
        Array.isArray(args) &&
        String(args[0]).startsWith("/compact")
      );
    }),
  );
  assertBaseProjection({
    result,
    transcript,
    runCount: 6,
    runStatuses: ["completed", "failed", "completed", "completed", "completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  const compactionRuns = [projection.runs[1], projection.runs[4]];
  const compactions = projection.turnItems.filter((item) => item.type === "compaction");
  assert.deepEqual(
    compactions.map((item) => [item.runId, item.status, item.title]),
    [
      [compactionRuns[0]?.id ?? null, "failed", "Compaction failed"],
      [compactionRuns[1]?.id ?? null, "completed", "Context compacted"],
    ],
  );
  assert.equal(compactions[0]?.summary, "Nothing to compact (session too small)");
  assert.isFalse(
    projection.turnItems.some(
      (item) =>
        compactionRuns.some((run) => run?.id === item.runId) && item.type === "assistant_message",
    ),
    "compaction must not run an assistant turn",
  );
  const compacted = result.domainEvents.filter(
    (event) =>
      event.type === "provider-thread.updated" &&
      event.payload.contextUsage?.contextUsageState === "unknown",
  );
  assert.isNotEmpty(
    compacted,
    "the SDK's unknown-after-compaction state must not become zero usage",
  );
  const recall = projection.turnItems.findLast((item) => item.type === "assistant_message");
  assert.include(recall?.text, PI_COMPACTION_MARKER);
}
