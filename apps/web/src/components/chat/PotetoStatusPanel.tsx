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

import { PotatoIcon } from "../icons/PotatoIcon";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { derivePotetoStatus, POTETO_PHASE_COPY } from "./potetoStatus.logic";

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
  const [stopRequested, setStopRequested] = useState<string | null>(null);
  const { copyToClipboard } = useCopyToClipboard({
    target: "candidate patch",
    onCopy: () => toastManager.add({ type: "success", title: "Patch copied" }),
    onError: () => toastManager.add({ type: "error", title: "Could not copy patch" }),
  });
  if (!progress) return null;

  const view = derivePotetoStatus(progress, props.pending);
  const stopping = props.pending && (view.stopping || stopRequested === progress.attemptId);
  const { active, retryable } = view;
  const statusLabel = stopping ? "Stopping…" : view.label;
  const phaseLabel = progress.phase
    ? POTETO_PHASE_COPY[progress.phase].label
    : active
      ? "Preparing"
      : "";
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
    if (action === "cancel" && result._tag === "Success") setStopRequested(progress.attemptId);
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
          <PotatoIcon width={18} height={18} />
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
                disabled={controlling || stopping}
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
        <p className="mt-2 text-sm text-muted-foreground" role="status">
          {stopping
            ? "Stopping safely; waiting for current work to finish. Retry is unavailable until it drains."
            : view.action}
        </p>
        <ol aria-label="Poteto phases" className="mt-2 grid grid-cols-3 gap-1.5 sm:grid-cols-6">
          {view.phases.map(({ phase, state }, index) => (
            <li
              key={phase}
              aria-current={state === "current" ? "step" : undefined}
              className={`rounded-md border px-2 py-1.5 text-xs ${state === "current" ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground"}`}
            >
              <span className="block">
                {index + 1}. {POTETO_PHASE_COPY[phase].label}
              </span>
              <span className="block text-3xs">
                {state === "complete"
                  ? "Complete"
                  : state === "current"
                    ? "Current phase"
                    : "Phase"}
              </span>
            </li>
          ))}
        </ol>
        {progress.reason ? (
          <p className="mt-1 text-sm text-warning-foreground">{progress.reason}</p>
        ) : null}
        {progress.baseCommit || progress.revision ? (
          <details className="mt-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer">Technical details</summary>
            <div className="mt-1 grid gap-x-3 gap-y-0.5 sm:grid-cols-2">
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
          </details>
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
                    {entry.phase ? POTETO_PHASE_COPY[entry.phase].label : "Poteto report"}
                  </div>
                  {potetoArtifactPreview(entry.artifact) ? (
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                      {entry.phase === "reproduce" &&
                      potetoArtifactPreview(entry.artifact) === "fail"
                        ? "Bug reproduced: the original code failed the checks."
                        : entry.phase === "verify" &&
                            potetoArtifactPreview(entry.artifact) === "pass"
                          ? "The candidate passed the checks."
                          : potetoArtifactPreview(entry.artifact)}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Evidence recorded for this phase. Expand the technical report for details.
                    </p>
                  )}
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      Technical report (JSON)
                    </summary>
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
                      {JSON.stringify(entry.artifact, null, 2)}
                    </pre>
                  </details>
                </li>
              ))}
            </ol>
          </details>
        ) : null}
        {progress.status === "candidate-ready" ? (
          patchPreview ? (
            <div className="mt-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void copyToClipboard(patch ?? "", undefined)}
                >
                  Copy patch
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    const url = URL.createObjectURL(
                      new Blob([patch ?? ""], { type: "text/plain" }),
                    );
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = "poteto-candidate.patch";
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }}
                >
                  Download patch
                </Button>
              </div>
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
            </div>
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
