import { OrchestratorMcpFailure } from "@getpaperplane/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as CuaDriver from "../../../computerUse/CuaDriver.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  CuaDriver.CuaDriver,
  ServerSettings.ServerSettingsService,
  ThreadManagementService.ThreadManagementService,
  McpInvocationContext.McpInvocationContext,
];

/**
 * Cua exposes ~60 operations whose schemas total ~150 KB. Mirroring them would
 * put that into every provider session, so agents discover them on demand.
 */
const ComputerDescribeTool = Tool.make("computer_describe", {
  description:
    "Control apps through Cua Driver. macOS and Windows use background-only host-window operations. Linux uses a private, offline desktop per thread with guest-only apps, focus, clipboard and temporary files. It cannot access host apps, profiles or project files. Call with no arguments for target-specific workflow guidance and operations, or with `tool` for its schema. Follow that guidance before acting. For web pages in Paperplane's browser panel, use preview_* instead.",
  parameters: Schema.Struct({
    tool: Schema.optional(Schema.NullOr(Schema.String)).annotate({
      description:
        "Operation name. Omit to list supported operations and target-specific workflow guidance.",
    }),
  }),
  success: McpSchema.CallToolResult,
  failure: OrchestratorMcpFailure,
  failureMode: "error",
  dependencies,
})
  .annotate(Tool.Title, "Describe computer use")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ComputerCallTool = Tool.make("computer_call", {
  description:
    "Run one Cua Driver operation on the server-owned target for this thread. Read target-specific guidance and the operation schema with computer_describe first. Host macOS and Windows input stays background-only. Linux input is confined to the private desktop. Do not pass session labels or change driver configuration. close_desktop discards the calling thread's Linux desktop. Refused actions execute nothing.",
  parameters: Schema.Struct({
    tool: Schema.String.annotate({ description: "Operation name from computer_describe." }),
    arguments: Schema.optional(
      Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
    ).annotate({
      description: "Arguments matching the operation's input schema.",
    }),
  }),
  success: McpSchema.CallToolResult,
  failure: OrchestratorMcpFailure,
  failureMode: "error",
  dependencies,
})
  .annotate(Tool.Title, "Use computer")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerUseToolkit = Toolkit.make(ComputerDescribeTool, ComputerCallTool);
