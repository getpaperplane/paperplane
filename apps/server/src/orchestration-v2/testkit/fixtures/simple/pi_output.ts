import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@rove-code/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { projectionFor } from "../shared.ts";
import { assertSimpleOutput } from "./codex_output.ts";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** The worker mirrors SDK stats before settlement; each turn keeps its own context total. */
export function assertPiSettledTokenUsage(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const states = transcript.entries.flatMap((entry) =>
    entry.type === "emit_inbound" && entry.label === "settled-state"
      ? [field(entry.frame, "state")]
      : [],
  );
  const projection = projectionFor(result, transcript.scenario);
  assert.lengthOf(projection.providerTurns, states.length);
  for (const [index, turn] of projection.providerTurns.entries()) {
    const context = field(field(states[index], "stats"), "contextUsage");
    const { updatedAt: _updatedAt, ...tokenUsage } = turn.tokenUsage ?? { updatedAt: "" };
    assert.deepEqual(tokenUsage, {
      usedTokens: field(context, "tokens"),
      maxTokens: field(context, "contextWindow"),
    });
  }
  const lastContext = field(field(states.at(-1), "stats"), "contextUsage");
  assert.equal(
    field(projection.providerThreads[0]?.contextUsage, "usedTokens"),
    field(lastContext, "tokens"),
  );
}

/** SDK thinking deltas and session-tree cursors survive the full orchestration path. */
export function assertPiSimpleOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertSimpleOutput(result, transcript);
  const projection = projectionFor(result, transcript.scenario);
  const thinking = transcript.entries
    .flatMap((entry) => {
      const update = field(
        field(entry.type === "emit_inbound" ? entry.frame : undefined, "event"),
        "assistantMessageEvent",
      );
      return field(update, "type") === "thinking_delta" ? [field(update, "delta")] : [];
    })
    .join("");
  assert.isNotEmpty(thinking);
  assert.deepEqual(
    projection.turnItems.flatMap((item) => (item.type === "reasoning" ? [item.text] : [])),
    [thinking],
  );
  assertPiSettledTokenUsage(result, transcript);
  const settled = transcript.entries.find(
    (entry) => entry.type === "emit_inbound" && entry.label === "settled-state",
  );
  const branch = field(settled?.type === "emit_inbound" ? settled.frame : undefined, "branch");
  const user = (Array.isArray(branch) ? branch : []).find(
    (entry) => field(field(entry, "message"), "role") === "user",
  );
  assert.isDefined(user);
  assert.equal(projection.providerTurns[0]?.nativeTurnRef?.nativeId, field(user, "id"));
  assert.equal(projection.providerTurns[0]?.nativeTurnRef?.strength, "strong");
  const usage = projection.providerThreads[0]?.contextUsage;
  assert.isNotNull(usage);
  assert.isDefined(usage);
  assert.isTrue("totalProcessedTokens" in usage);
  assert.isAbove("totalProcessedTokens" in usage ? (usage.totalProcessedTokens ?? 0) : 0, 0);
}
