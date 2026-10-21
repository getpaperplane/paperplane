import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@rove-code/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
} from "../shared.ts";

function field(frame: unknown, key: string): unknown {
  return typeof frame === "object" && frame !== null ? Reflect.get(frame, key) : undefined;
}

/**
 * User Stop while Pi runs a bash tool. Abort settles the SDK prompt before
 * disposal; the stopped turn keeps its native tree cursor for later rollback.
 */
export function assertTurnInterruptMidToolPiOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const toolStartIndex = transcript.entries.findIndex(
    (entry) =>
      entry.type === "emit_inbound" &&
      field(field(entry.frame, "event"), "type") === "tool_execution_start",
  );
  const abortIndex = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && field(entry.frame, "method") === "abort",
  );
  assert.isAtLeast(toolStartIndex, 0, "Pi must record the bash tool starting");
  assert.isAbove(abortIndex, toolStartIndex, "Stop must abort after the tool started");

  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["interrupted"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertTurnItemTypes(projection, [
    "user_message",
    "command_execution",
    "run_interrupt_request",
    "run_interrupt_result",
  ]);
  assertUserMessagesInclude(projection, [TURN_INTERRUPT_MID_TOOL_PROMPT]);

  const commandItem = projection.turnItems.find((item) => item.type === "command_execution");
  assert.isDefined(commandItem);
  assert.include(commandItem.input, "node -e");
  // The SDK reports the tool failure independently of the interrupted root turn.
  assert.equal(commandItem.status, "failed");
  const interruptResult = projection.turnItems.find((item) => item.type === "run_interrupt_result");
  assert.equal(interruptResult?.status, "interrupted");
  assert.deepEqual(
    projection.providerTurns.map((turn) => turn.status),
    ["interrupted"],
  );
  // Mirrored before SDK disposal, so a later rollback can navigate past this turn.
  assert.equal(projection.providerTurns[0]?.nativeTurnRef?.strength, "strong");
  assert.deepEqual(
    projection.providerSessions.map((session) => [session.status, session.lastError]),
    [["ready", null]],
    "Stop disposes the SDK session without breaking the instance runtime",
  );
}
