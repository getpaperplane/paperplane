import * as Effect from "effect/Effect";
import * as BackgroundCommandService from "../../../orchestration-v2/BackgroundCommandService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { BackgroundCommandsToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const commands = yield* BackgroundCommandService.BackgroundCommandService;
  const caller = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    return (yield* McpInvocationContext.requireThreadScope(scope, "Background commands")).thread;
  });
  return {
    start_background_command: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const thread = yield* caller;
        const itemId = yield* commands.start({
          ...input,
          threadId: thread.threadId,
          providerInstanceId: thread.providerInstanceId,
        });
        return { itemId };
      }),
    ),
    background_command_status: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        const thread = yield* caller;
        const item = yield* commands.status({ ...input, threadId: thread.threadId });
        return {
          itemId: item.id,
          status: item.status,
          command: item.input,
          title: item.title,
          output: item.output ?? "",
          exitCode: item.exitCode ?? null,
          stopRequested: item.execution?.stopRequested ?? false,
        };
      }),
    ),
    stop_background_command: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const thread = yield* caller;
        yield* commands.stop({ ...input, threadId: thread.threadId });
        return { itemId: input.itemId };
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof BackgroundCommandsToolkit.tools>;
});
export const layer = McpToolAccess.toLayer(BackgroundCommandsToolkit, make);
