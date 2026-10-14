import { useAtomCommand } from "~/state/use-atom-command";
import { threadEnvironment } from "~/state/threads";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@rove-code/client-runtime/state/runtime";
import {
  potetoArtifactPreview,
  type PotetoActivityArtifact,
} from "@rove-code/client-runtime/poteto";
import type { EnvironmentId, PotetoProgress, ThreadId } from "@rove-code/contracts";
import { useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

const PHASE_LABELS = {
  reproduce: "Reproduce",
  investigate: "Investigate",
  design: "Design",
  implement: "Implement",
  verify: "Verify",
  review: "Review",
} as const;

const STATUS_VARIANTS = {
  requested: "secondary",
  running: "info",
  blocked: "warning",
  interrupted: "warning",
  cancelled: "outline",
  "candidate-ready": "success",
} as const;

export function PotetoStatusPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly progress: PotetoProgress | null;
  readonly artifacts: ReadonlyArray<PotetoActivityArtifact>;
  readonly pending: boolean;
}) {
  const { progress, artifacts } = props;
  const [controlling, setControlling] = useState(false);
  const controlPoteto = useAtomCommand(threadEnvironment.controlPoteto, { reportFailure: false });
  if (!progress) return null;

  const active = progress.status === "requested" || progress.status === "running";
  const retryable =
    !props.pending &&
    (progress.status === "blocked" ||
      progress.status === "interrupted" ||
      progress.status === "cancelled");
  const statusLabel = progress.status === "candidate-ready" ? "Candidate ready" : progress.status;
  const phaseLabel = progress.phase ? PHASE_LABELS[progress.phase] : active ? "Preparing" : "";
  const patch = progress.status === "candidate-ready" ? progress.patch : undefined;
  const patchPreview =
    patch && patch.length > 24_000 ? `${patch.slice(0, 24_000)}\n… patch preview truncated` : patch;

  const handleControl = async (action: "cancel" | "retry") => {
    if (controlling) return;
    setControlling(true);
    const result = await controlPoteto({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, runId: progress.runId, action },
    });
    setControlling(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: action === "cancel" ? "Could not stop Poteto Mode" : "Could not retry Poteto Mode",
        description: error instanceof Error ? error.message : "The request was rejected.",
      });
    }
  };

  return (
    <section
      className="mx-auto w-full max-w-(--chat-max-width) px-4 pb-2"
      aria-label="Poteto Mode status"
    >
      <div className="max-h-[45dvh] overflow-y-auto rounded-xl border border-border bg-card/72 px-3 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">Poteto Mode</span>
          <Badge variant={STATUS_VARIANTS[progress.status]} size="sm">
            {statusLabel}
          </Badge>
          <span className="text-xs text-muted-foreground">{phaseLabel}</span>
          <span className="ms-auto flex gap-2">
            {active ? (
              <Button
                size="xs"
                variant="outline"
                disabled={controlling}
                onClick={() => void handleControl("cancel")}
              >
                Stop
              </Button>
            ) : null}
            {retryable ? (
              <Button
                size="xs"
                variant="outline"
                disabled={controlling}
                onClick={() => void handleControl("retry")}
              >
                Retry
              </Button>
            ) : null}
          </span>
        </div>
        {progress.reason ? (
          <p className="mt-1 text-sm text-warning-foreground">{progress.reason}</p>
        ) : null}
        {progress.baseCommit || progress.revision ? (
          <div className="mt-1 grid gap-x-3 gap-y-0.5 text-xs text-muted-foreground sm:grid-cols-2">
            {progress.baseCommit ? (
              <div className="min-w-0">
                <span>Base </span>
                <code className="break-all text-foreground/80">{progress.baseCommit}</code>
              </div>
            ) : null}
            {progress.revision ? (
              <div className="min-w-0">
                <span>Revision </span>
                <code className="break-all text-foreground/80">{progress.revision}</code>
              </div>
            ) : null}
          </div>
        ) : null}
        {artifacts.length > 0 ? (
          <details className="group/poteto-artifacts mt-2 border-t border-border/70 pt-1.5">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
              Evidence and reports ({artifacts.length})
            </summary>
            <ol className="mt-2 space-y-2">
              {artifacts.map((entry) => (
                <li key={entry.id} className="min-w-0 rounded-lg bg-muted/48 px-2.5 py-2">
                  <div className="text-xs font-medium text-foreground">
                    {entry.phase ? PHASE_LABELS[entry.phase] : "Poteto report"}
                  </div>
                  {potetoArtifactPreview(entry.artifact) ? (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {potetoArtifactPreview(entry.artifact)}
                    </p>
                  ) : null}
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
                    {JSON.stringify(entry.artifact, null, 2)}
                  </pre>
                </li>
              ))}
            </ol>
          </details>
        ) : null}
        {progress.status === "candidate-ready" ? (
          patchPreview ? (
            <details className="mt-2 border-t border-border/70 pt-1.5">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
                View candidate patch
              </summary>
              <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-muted/48 p-2.5 font-mono text-xs text-foreground">
                {patchPreview}
              </pre>
              <p className="mt-1 text-xs text-muted-foreground">
                Reviewed candidate only. This patch has not been applied.
              </p>
            </details>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              No patch was attached to this candidate.
            </p>
          )
        ) : null}
      </div>
    </section>
  );
}
