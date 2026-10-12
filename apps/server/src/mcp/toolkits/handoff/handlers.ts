import {
  ImportedThreadHandoff,
  THREAD_HANDOFF_ACTIVITY_KIND,
  ThreadHandoffError,
} from "@rove-code/contracts";
import { readHandoffPage } from "@rove-code/shared/threadHandoff";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ProjectionThreadActivityRepository } from "../../../persistence/Services/ProjectionThreadActivities.ts";
import { HandoffToolkit } from "./tools.ts";

const isImportedThreadHandoff = Schema.is(ImportedThreadHandoff);
const isThreadHandoffError = Schema.is(ThreadHandoffError);

export const HandoffToolkitHandlersLive = HandoffToolkit.toLayer(
  Effect.gen(function* () {
    const activities = yield* ProjectionThreadActivityRepository;
    return HandoffToolkit.of({
      read_thread_handoff: (input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext;
          const rows = yield* activities.listByThreadId({
            threadId: scope.threadId,
            activityKinds: [THREAD_HANDOFF_ACTIVITY_KIND],
            limit: 1,
          });
          const imported = rows
            .flatMap((row) => (isImportedThreadHandoff(row.payload) ? [row.payload.handoff] : []))
            .at(0);
          if (
            !imported ||
            (input.transferId !== undefined && input.transferId !== imported.transferId)
          )
            return yield* new ThreadHandoffError({
              kind: "history",
              message: "This thread has no matching imported handoff.",
            });
          return yield* Effect.try({
            try: () => readHandoffPage(imported, input),
            catch: () =>
              new ThreadHandoffError({
                kind: "history",
                message: "This item was not imported into this thread.",
              }),
          });
        }).pipe(
          Effect.mapError((error) =>
            isThreadHandoffError(error)
              ? error
              : new ThreadHandoffError({
                  kind: "history",
                  message: "Could not read the imported history.",
                }),
          ),
        ),
    });
  }),
);
