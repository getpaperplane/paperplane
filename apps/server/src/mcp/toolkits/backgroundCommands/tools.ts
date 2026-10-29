import {
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
  TurnItemId,
} from "@getpaperplane/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as BackgroundCommandService from "../../../orchestration-v2/BackgroundCommandService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  BackgroundCommandService.BackgroundCommandService,
  ThreadManagementService.ThreadManagementService,
];
const failure = Schema.Union([
  OrchestratorMcpFailure,
  BackgroundCommandService.BackgroundCommandError,
]);
const result = Schema.Struct({ itemId: TurnItemId });
export const BackgroundCommandsToolkit = Toolkit.make(
  Tool.make("start_background_command", {
    description:
      "Start a long-running command or dev server in this thread's workspace. Paperplane owns its process independently of the provider turn and shows it in Running with Stop. Retry with the same clientRequestId and identical input to recover the same item. No detached shell or polling loop is needed.",
    parameters: Schema.Struct({
      clientRequestId: TrimmedNonEmptyString,
      command: TrimmedNonEmptyString,
      title: Schema.optional(TrimmedNonEmptyString),
    }),
    success: result,
    failure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, true),
  Tool.make("background_command_status", {
    description:
      "Read this thread's Paperplane background command status and bounded output tail by itemId.",
    parameters: Schema.Struct({ itemId: TurnItemId }),
    success: Schema.Struct({
      itemId: TurnItemId,
      status: Schema.String,
      command: Schema.String,
      title: Schema.NullOr(Schema.String),
      output: Schema.String,
      exitCode: Schema.NullOr(Schema.Int),
      stopRequested: Schema.Boolean,
    }),
    failure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("stop_background_command", {
    description:
      "Request termination of this thread's Paperplane background command by itemId. Status settles only after the process exits. Safe to repeat.",
    parameters: Schema.Struct({
      itemId: TurnItemId,
      clientRequestId: Schema.optional(TrimmedNonEmptyString),
    }),
    success: result,
    failure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, true),
);
