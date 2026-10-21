import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@rove-code/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
  PROVIDER_THREAD_RESUME_FIRST_PROMPT,
  PROVIDER_THREAD_RESUME_SECOND_PROMPT,
} from "../shared.ts";

const FIRST_FINAL = "provider thread resume fixture first turn complete";
const SECOND_FINAL = "provider thread resume fixture second turn complete";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * Pi's durable native thread id is its session file. After idle release,
 * the SDK session factory must receive that cursor, and the resumed model
 * still sees the first exchange.
 */
export function assertPiProviderThreadResumeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const creates = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" && field(entry.frame, "method") === "createSession"
      ? [field(entry.frame, "input")]
      : [],
  );
  assert.lengthOf(creates, 2, "idle release must dispose and reopen the SDK session");
  assert.equal(field(creates[0], "resumeSessionFile"), undefined);
  assert.equal(field(creates[1], "resumeSessionFile"), "/pi-sessions/session-1.jsonl");
  assert.equal(field(creates[1], "resumeSessionId"), "session-1");

  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [
    PROVIDER_THREAD_RESUME_FIRST_PROMPT,
    PROVIDER_THREAD_RESUME_SECOND_PROMPT,
  ]);
  assert.lengthOf(projection.providerThreads, 1, "resume must keep one provider thread");
  assert.equal(
    projection.providerThreads[0]?.nativeThreadRef?.nativeId,
    "/pi-sessions/session-1.jsonl",
  );
  const answers = projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" ? [item.text] : [],
  );
  assert.lengthOf(answers, 2);
  assert.include(answers[1], FIRST_FINAL, "the resumed session must remember the first answer");
  assert.include(answers[1], SECOND_FINAL);
}
