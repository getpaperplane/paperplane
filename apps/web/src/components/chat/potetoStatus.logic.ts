import type { PotetoProgress } from "@rove-code/contracts";

export const POTETO_PHASE_COPY = {
  reproduce: { label: "Reproduce", meaning: "Confirm the problem with a failing check." },
  investigate: { label: "Investigate", meaning: "Find why the problem happens." },
  design: { label: "Design", meaning: "Compare approaches and choose a repair." },
  implement: { label: "Implement", meaning: "Build the repair in an isolated workspace." },
  verify: { label: "Verify", meaning: "Run checks against the candidate repair." },
  review: { label: "Review", meaning: "Inspect the candidate for remaining issues." },
} as const;

export function derivePotetoStatus(
  progress: Pick<PotetoProgress, "status" | "phase">,
  pending: boolean,
) {
  const active = progress.status === "requested" || progress.status === "running";
  const stopping = pending && !active;
  const retryable = !pending && ["blocked", "interrupted", "cancelled"].includes(progress.status);
  const phases = ["reproduce", "investigate", "design", "implement", "verify", "review"] as const;
  const current = progress.phase ? phases.indexOf(progress.phase) : -1;
  return {
    active,
    stopping,
    retryable,
    label: stopping
      ? "Finishing up"
      : progress.status === "candidate-ready"
        ? "Candidate ready"
        : progress.status,
    phases: phases.map((phase, index) => ({
      phase,
      // Progress does not carry accepted-phase receipts; do not imply earlier phases passed.
      state:
        progress.status === "candidate-ready" ? "complete" : index === current ? "current" : "idle",
    })),
    action: stopping
      ? "Waiting for the current work to stop safely. Retry will be available after it finishes."
      : active
        ? progress.phase
          ? POTETO_PHASE_COPY[progress.phase].meaning
          : "Preparing an isolated workspace and checks."
        : progress.status === "candidate-ready"
          ? "Ready for your review. Nothing has been applied to your working files."
          : "This attempt has stopped. Retry resumes from accepted phases rather than starting over.",
  };
}
