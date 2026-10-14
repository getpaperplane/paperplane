import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@rove-code/client-runtime/state/runtime";
import {
  POTETO_PROJECT_SPEC_EXAMPLE,
  validatePotetoProjectSpecJson,
} from "@rove-code/client-runtime/poteto";
import type { EnvironmentId, ThreadId } from "@rove-code/contracts";
import { useMemo, useState, type FormEvent } from "react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

export function PotetoModeDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly open: boolean;
  readonly enabled: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onBeforeStart: () => Promise<AtomCommandResult<void, unknown>>;
}) {
  const [specJson, setSpecJson] = useState(POTETO_PROJECT_SPEC_EXAMPLE);
  const [submitting, setSubmitting] = useState(false);
  const validation = useMemo(() => validatePotetoProjectSpecJson(specJson), [specJson]);
  const startPoteto = useAtomCommand(threadEnvironment.startPoteto, { reportFailure: false });

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!props.enabled || !validation.valid || submitting) return;
    setSubmitting(true);
    const prepared = await props.onBeforeStart();
    const result =
      prepared._tag === "Failure"
        ? prepared
        : await startPoteto({
            environmentId: props.environmentId,
            input: { threadId: props.threadId, spec: validation.spec },
          });
    setSubmitting(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not start Poteto Mode",
          description: error instanceof Error ? error.message : "The request was rejected.",
        });
      }
      return;
    }
    props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-2xl" render={<form onSubmit={handleSubmit} />}>
        <DialogHeader>
          <DialogTitle>Poteto Mode</DialogTitle>
          <DialogDescription>
            Define the task, committed file scope, and dependency-free JavaScript or TypeScript
            checks.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            <label htmlFor="poteto-project-spec" className="text-sm font-medium">
              Project spec (JSON)
            </label>
            <Textarea
              id="poteto-project-spec"
              aria-label="Project spec JSON"
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              rows={16}
              value={specJson}
              onChange={(event) => setSpecJson(event.currentTarget.value)}
            />
            {!validation.valid ? (
              <ul role="alert" className="list-disc space-y-1 ps-5 text-sm text-destructive">
                {validation.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            ) : null}
            <p className="text-sm text-muted-foreground">
              Runs from committed HEAD in an isolated Docker candidate. Docker must be available on
              the host. The candidate is never applied automatically.
            </p>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!props.enabled || !validation.valid || submitting}>
            {submitting ? "Starting…" : "Start Poteto Mode"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
