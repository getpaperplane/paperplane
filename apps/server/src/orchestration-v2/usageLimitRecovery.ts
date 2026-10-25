import type { OrchestrationV2Run, RunId } from "@getpaperplane/contracts";

export const MAX_LIMIT_RECOVERY_ATTEMPTS = 3;

/** Only automatic continuations count; an ordinary user send starts a new chain. */
export function limitRecoveryAttempts(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "usageLimitContinuationOfRunId">>,
  latestRunId: RunId | null,
): number {
  let run = runs.find((candidate) => candidate.id === latestRunId);
  let attempts = 0;
  while (run?.usageLimitContinuationOfRunId && attempts < MAX_LIMIT_RECOVERY_ATTEMPTS) {
    attempts++;
    const parentId = run.usageLimitContinuationOfRunId;
    run = runs.find((candidate) => candidate.id === parentId);
  }
  return attempts;
}

/**
 * An explicit usage-limit continuation extends its chain; a restart continuation of an
 * automatic retry inherits the source's link so the attempt count is not reset.
 */
export function usageLimitChain(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "usageLimitContinuationOfRunId">>,
  command: {
    readonly usageLimitContinuationOfRunId?: RunId | undefined;
    readonly restartContinuationOfRunId?: RunId | undefined;
  },
): { readonly usageLimitContinuationOfRunId?: RunId } {
  const parent =
    command.usageLimitContinuationOfRunId ??
    runs.find((run) => run.id === command.restartContinuationOfRunId)
      ?.usageLimitContinuationOfRunId;
  return parent === undefined ? {} : { usageLimitContinuationOfRunId: parent };
}
