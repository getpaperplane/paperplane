import type { OrchestrationV2ProviderFailure } from "@rove-code/contracts";

/** Labels process memory failures without hiding a provider's usage limit. */
export function labelOutOfMemory(
  failure: OrchestrationV2ProviderFailure,
  verdict: "confirmed" | "likely" | null,
): OrchestrationV2ProviderFailure {
  // Only typed process-exit evidence survives normalization as this code. Claude,
  // OpenCode, Muse and Pi RPC failures without kill evidence get no likely label.
  if (
    verdict === null ||
    failure.class === "usage_limit" ||
    (verdict === "likely" && failure.code !== "process_exit_sigkill")
  ) {
    return failure;
  }
  return {
    ...failure,
    message:
      verdict === "confirmed"
        ? "Killed: out of memory."
        : 'Likely killed: the host ran out of memory. Run fewer agents at once or add swap (see "Small or WSL hosts" in the Paperplane docs).',
    code: "oom_kill",
  };
}
