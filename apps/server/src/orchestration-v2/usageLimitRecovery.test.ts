import { assert, it } from "@effect/vitest";
import { RunId } from "@getpaperplane/contracts";
import { limitRecoveryAttempts, usageLimitChain } from "./usageLimitRecovery.ts";

const id = (name: string) => RunId.make(`run:${name}`);
const runs = [
  { id: id("a") },
  { id: id("b"), usageLimitContinuationOfRunId: id("a") },
  { id: id("c"), usageLimitContinuationOfRunId: id("b") },
  { id: id("restart"), restartOnly: true },
];

it("a restart continuation of an automatic retry carries the chain forward", () => {
  assert.deepEqual(usageLimitChain(runs, { restartContinuationOfRunId: id("c") }), {
    usageLimitContinuationOfRunId: id("b"),
  });
  const next = [...runs, { id: id("d"), usageLimitContinuationOfRunId: id("b") }];
  assert.equal(limitRecoveryAttempts(next, id("d")), 2);
  assert.deepEqual(usageLimitChain(runs, { restartContinuationOfRunId: id("a") }), {});
  assert.deepEqual(usageLimitChain(runs, { usageLimitContinuationOfRunId: id("c") }), {
    usageLimitContinuationOfRunId: id("c"),
  });
});
