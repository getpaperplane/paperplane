import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@rove-code/client-runtime/state/runtime";
import { validatePotetoProjectSpecJson } from "@rove-code/client-runtime/poteto";
import type {
  EnvironmentId,
  ModelSelection,
  PotetoProjectSpec,
  ThreadId,
} from "@rove-code/contracts";
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { PotatoIcon } from "../icons/PotatoIcon";
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
import { threadEnvironment } from "~/state/threads";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

interface ReviewedDraft {
  readonly spec: PotetoProjectSpec;
  readonly modelSelection: ModelSelection;
}

export function PotetoModeDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly open: boolean;
  readonly enabled: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly getModelSelection: () => ModelSelection | null;
  readonly onBeforeStart: (model: ModelSelection) => Promise<AtomCommandResult<void, unknown>>;
}) {
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState<ReviewedDraft | null>(null);
  const [pending, setPending] = useState<"draft" | "start" | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const draftPoteto = useAtomCommand(serverEnvironment.potetoDraft, { reportFailure: false });
  const startPoteto = useAtomCommand(threadEnvironment.startPoteto, { reportFailure: false });

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!props.enabled || pendingRef.current) return;
    if (!draft && !description.trim()) return;
    pendingRef.current = true;
    setError(null);
    setPending(draft ? "start" : "draft");
    try {
      if (!draft) {
        const modelSelection = props.getModelSelection();
        if (!modelSelection) {
          setError("Select a Pi model in the composer first.");
          return;
        }
        const result = await draftPoteto({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, description: description.trim(), modelSelection },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) throw squashAtomCommandFailure(result);
          return;
        }
        if (result.value.status === "unsupported") {
          setError(result.value.reason);
          return;
        }
        const validation = validatePotetoProjectSpecJson(JSON.stringify(result.value.spec));
        if (!validation.valid) {
          setError(
            "The proposed scope or checks could not be validated. Refine the description and try again.",
          );
          return;
        }
        setDraft({ spec: validation.spec, modelSelection });
        return;
      }
      // Freeze the model with the reviewed proposal, not a picker changed while this was open.
      const prepared = await props.onBeforeStart(draft.modelSelection);
      const result =
        prepared._tag === "Failure"
          ? prepared
          : await startPoteto({
              environmentId: props.environmentId,
              input: { threadId: props.threadId, spec: draft.spec },
            });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) throw squashAtomCommandFailure(result);
        return;
      }
      props.onOpenChange(false);
      setDraft(null);
      setDescription("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not complete this request. Try again.",
      );
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (pending !== "start") props.onOpenChange(open);
      }}
    >
      <DialogPopup className="max-w-2xl" render={<form onSubmit={handleSubmit} />}>
        <DialogHeader>
          <div className="flex items-center gap-2.5">
            <PotatoIcon className="size-6 shrink-0 text-warning-foreground" />
            <DialogTitle>Poteto Mode</DialogTitle>
          </div>
          <DialogDescription>
            {draft
              ? "Review the proposal. You decide what can change and what counts as fixed."
              : "A more deliberate bug fix. Reproduce it, compare approaches, and independently review the patch."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel scrollFade={false}>
          <ol aria-label="Setup steps" className="mb-5 flex items-center gap-3 text-xs">
            <li
              aria-current={!draft ? "step" : undefined}
              className={!draft ? "font-medium text-foreground" : "text-muted-foreground"}
            >
              1. Describe the bug
            </li>
            <ArrowRightIcon aria-hidden="true" className="size-3 text-muted-foreground" />
            <li
              aria-current={draft ? "step" : undefined}
              className={draft ? "font-medium text-foreground" : "text-muted-foreground"}
            >
              2. Review & start
            </li>
          </ol>
          {draft ? (
            <div className="space-y-5">
              <section aria-label="Proposed fix">
                <h3 className="mb-1.5 text-sm font-medium">What should change</h3>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                  {draft.spec.task}
                </p>
              </section>
              <section aria-label="Approved file scope">
                <h3 className="mb-2 text-sm font-medium">Where the agent can work</h3>
                <ul className="divide-y divide-border rounded-lg border border-border text-xs">
                  {draft.spec.editableFiles.map((file) => (
                    <li
                      key={file}
                      className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2"
                    >
                      <code className="min-w-0 break-all">{file}</code>
                      <span className="shrink-0 text-muted-foreground">Can change</span>
                    </li>
                  ))}
                  {draft.spec.contextFiles.map((file) => (
                    <li
                      key={file}
                      className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2"
                    >
                      <code className="min-w-0 break-all">{file}</code>
                      <span className="shrink-0 text-muted-foreground">Read only</span>
                    </li>
                  ))}
                </ul>
              </section>
              <section aria-label="Proposed checks">
                <h3 className="mb-1 text-sm font-medium">What counts as fixed</h3>
                <p className="mb-2 break-all text-xs text-muted-foreground">
                  Checks for <code>{draft.spec.check.export}</code> in{" "}
                  <code>{draft.spec.check.module}</code>. These are proposed expectations, not
                  passing results yet.
                </p>
                <ol className="space-y-1.5">
                  {draft.spec.check.cases.map((test, index) => (
                    <li
                      key={index}
                      className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2 font-mono text-xs"
                    >
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {index + 1}.
                      </span>
                      <span className="min-w-0 break-words">
                        {draft.spec.check.export}(
                        {test.args.map((arg) => JSON.stringify(arg)).join(", ")})
                        <span className="mx-2 text-muted-foreground">→</span>
                        {JSON.stringify(test.expected)}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
              <div className="space-y-2 border-t border-border pt-4 text-xs text-muted-foreground">
                <p className="flex items-start gap-2">
                  <CheckIcon className="size-3.5 shrink-0" />
                  Rove enforces each phase and checks the results. A model cannot skip ahead.
                </p>
                <p>
                  Uses{" "}
                  <span className="break-all text-foreground">{draft.modelSelection.model}</span>.
                  Starting makes multiple model calls and runs checks in Docker. Docker and its
                  prepared image must be available on the host.
                </p>
                <p>
                  Runs from committed HEAD when started. Uncommitted changes are excluded. You
                  receive a patch to review; nothing is applied or committed automatically.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="poteto-description" className="text-sm font-medium">
                  What’s going wrong?
                </label>
                <Textarea
                  id="poteto-description"
                  aria-label="Describe the bug"
                  rows={6}
                  autoGrow={false}
                  maxLength={4096}
                  value={description}
                  disabled={pending !== null}
                  placeholder="Describe what happens and what you expected instead. Include a file path or function name if you know it."
                  onChange={(event) => {
                    setDescription(event.currentTarget.value);
                    setError(null);
                  }}
                />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  No spec or test file needed. Your selected Pi model reads committed source and
                  drafts the allowed files and checks for you to approve.
                </p>
              </div>
              <div className="space-y-2 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">A focused pilot.</span> Small
                  JavaScript or TypeScript functions with simple inputs and outputs. Full-app,
                  browser, and dependency-heavy bugs are not supported yet.
                </p>
                <p>
                  Drafting uses your selected model and may incur model usage. It can only read a
                  bounded committed snapshot—not run code or change files. Validation starts only
                  after your approval.
                </p>
              </div>
              {pending === "draft" ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Reading committed source and drafting checks… You can close this and return to the
                  proposal.
                </p>
              ) : null}
            </div>
          )}
          {error ? (
            <div
              role="alert"
              className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 p-3"
            >
              <p className="text-sm font-medium">
                {draft ? "The run could not start" : "We couldn’t prepare a proposal"}
              </p>
              <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                {error}
              </p>
              {!draft ? (
                <p className="text-xs text-muted-foreground">
                  Try adding the relevant file path and a concrete example of the expected result.
                </p>
              ) : null}
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {draft ? (
            <Button
              type="button"
              variant="ghost"
              disabled={pending !== null}
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
            >
              <ArrowLeftIcon />
              Refine description
            </Button>
          ) : (
            <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
              Close
            </Button>
          )}
          <Button
            type="submit"
            disabled={!props.enabled || pending !== null || (!draft && !description.trim())}
          >
            {pending === "draft"
              ? "Preparing proposal…"
              : pending === "start"
                ? "Starting…"
                : draft
                  ? "Approve & start"
                  : "Prepare proposal"}
            {pending === null ? draft ? <PotatoIcon /> : <ArrowRightIcon /> : null}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
