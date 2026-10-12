import { NonNegativeInt, TrimmedNonEmptyString, ThreadHandoffError } from "@rove-code/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ProjectionThreadActivityRepository } from "../../../persistence/Services/ProjectionThreadActivities.ts";

export const ReadThreadHandoffInput = Schema.Struct({
  transferId: Schema.optional(TrimmedNonEmptyString),
  itemId: Schema.optional(TrimmedNonEmptyString),
  offset: Schema.optional(NonNegativeInt),
  textOffset: Schema.optional(NonNegativeInt),
});
export type ReadThreadHandoffInput = typeof ReadThreadHandoffInput.Type;

export const HandoffToolkit = Toolkit.make(
  Tool.make("read_thread_handoff", {
    description:
      "Read portable history imported into this thread. With no itemId, list item IDs and lengths using offset/nextOffset. With itemId, read its text using textOffset/nextTextOffset until null. This reads the destination's saved artifact even when the original machine is offline. It cannot recover items or attachments that were not transferred.",
    parameters: ReadThreadHandoffInput,
    success: Schema.Unknown,
    failure: ThreadHandoffError,
    dependencies: [McpInvocationContext, ProjectionThreadActivityRepository],
  }).annotate(Tool.Readonly, true),
);
