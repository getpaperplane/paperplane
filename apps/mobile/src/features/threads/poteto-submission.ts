import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@rove-code/client-runtime/state/runtime";
import type { ModelSelection, ThreadId } from "@rove-code/contracts";

export function requirePotetoCommandSuccess(result: AtomCommandResult<unknown, unknown>): void {
  if (result._tag !== "Failure") return;
  if (isAtomCommandInterrupted(result)) {
    throw new Error("The Poteto request was interrupted. Try again.");
  }
  throw squashAtomCommandFailure(result);
}

/** Reuse one creation, including effect replays and approval after drafting. */
export function createPotetoThreadTarget(create: () => Promise<ThreadId>) {
  let request: Promise<ThreadId> | null = null;
  return () => {
    request ??= create().catch((error) => {
      request = null;
      throw error;
    });
    return request;
  };
}

/** Starting must use the reviewed model, and never consume edits made during the request. */
export async function startReviewedPoteto(input: {
  readonly modelSelection: ModelSelection;
  readonly description: string;
  readonly prepare: (
    modelSelection: ModelSelection,
  ) => Promise<AtomCommandResult<{ readonly sequence: number }, unknown>>;
  readonly start: () => Promise<AtomCommandResult<{ readonly sequence: number }, unknown>>;
  readonly readPrompt: () => string;
  readonly clearPrompt: () => void;
}): Promise<void> {
  requirePotetoCommandSuccess(await input.prepare(input.modelSelection));
  requirePotetoCommandSuccess(await input.start());
  if (input.readPrompt() === input.description) input.clearPrompt();
}
