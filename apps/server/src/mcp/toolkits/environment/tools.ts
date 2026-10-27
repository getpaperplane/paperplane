import {
  AgentSkillsStatus,
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
  HostHealthReport,
  OrchestratorMcpFailure,
  ServerSettings,
  ServerSettingsPatch,
} from "@getpaperplane/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as AgentSkills from "../../../agentSkills/AgentSkills.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as HostHealth from "../../../diagnostics/HostHealth.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const PreferenceFields = {
  defaultThreadEnvMode: ServerSettings.fields.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: ServerSettings.fields.newWorktreesStartFromOrigin,
  enableProviderUpdateChecks: ServerSettings.fields.enableProviderUpdateChecks,
  backgroundActivity: Schema.Struct({ profile: BackgroundActivityProfileSelection }),
  sourceControlWritingStyle: Schema.Struct({
    mode: Schema.String,
    followChangeRequestTemplates: Schema.Boolean,
    customInstructions: Schema.String,
    truncated: Schema.Boolean,
  }),
};
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    ThreadCommandExecutor.ThreadCommandExecutor,
    AgentSkills.AgentSkills,
  ],
};
const EnvironmentReadTool = Tool.make("paperplane_environment_read", {
  ...shared,
  description:
    "Read this server's identity, selected environment preferences, and host memory health when available. Provider/model availability is exposed by orchestrator_capabilities. Writing instructions are limited to 4,000 characters.",
  dependencies: [...shared.dependencies, HostHealth.HostHealth],
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
    hostHealth: Schema.optionalKey(HostHealthReport),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPreferencesTool = Tool.make("paperplane_environment_preferences_update", {
  ...shared,
  description:
    "Update selected environment-wide preferences through normal settings persistence and notifications. Requires a live full-access/default calling thread. Omitted fields are preserved; empty customInstructions clears them.",
  parameters: Schema.Struct({
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
  }),
  success: Schema.Struct(PreferenceFields),
}).annotate(Tool.Destructive, true);
const AgentSkillsStatusTool = Tool.make("paperplane_agent_skills_status", {
  ...shared,
  description:
    "Read the shared agent skills folder (~/.agents/skills) on this machine: its skills and, when it is a git repository, whether it is ahead of, behind, or diverged from its remote. Pass fetch=true to refresh the remote state first.",
  parameters: Schema.Struct({
    fetch: Schema.optionalKey(Schema.Boolean),
  }),
  success: AgentSkillsStatus,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const AgentSkillsSyncTool = Tool.make("paperplane_agent_skills_sync", {
  ...shared,
  description:
    "Sync the shared agent skills folder with its git remote: commit local changes, fast-forward from the remote, and push. Refuses when local and remote both changed (diverged); resolve that in the folder by hand. Requires the folder to be a git repository with a remote.",
  success: AgentSkillsStatus,
}).annotate(Tool.Destructive, true);
export const EnvironmentToolkit = Toolkit.make(
  EnvironmentReadTool,
  EnvironmentPreferencesTool,
  AgentSkillsStatusTool,
  AgentSkillsSyncTool,
);
