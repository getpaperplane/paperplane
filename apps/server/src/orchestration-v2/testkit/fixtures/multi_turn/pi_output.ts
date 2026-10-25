import type { ProviderReplayTranscript } from "@getpaperplane/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertPiSettledTokenUsage } from "../simple/pi_output.ts";
import { assertMultiTurnOutput } from "./codex_output.ts";

/**
 * Each turn keeps its SDK context total rather than the last turn's usage.
 */
export function assertPiMultiTurnOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertMultiTurnOutput(result, transcript);
  assertPiSettledTokenUsage(result, transcript);
}
