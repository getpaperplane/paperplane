import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The shared `~/.agents/skills` folder this environment manages. Each entry is
 * an immediate subdirectory holding a `SKILL.md`.
 */
export const AgentSkillEntry = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  path: Schema.String,
  /** First 16 hex chars of the SHA-256 of the SKILL.md bytes. */
  contentHash: Schema.String,
});
export type AgentSkillEntry = typeof AgentSkillEntry.Type;

export const AgentSkillsGitStatus = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  remoteUrl: Schema.NullOr(Schema.String),
  ahead: Schema.Number,
  behind: Schema.Number,
  dirty: Schema.Boolean,
  diverged: Schema.Boolean,
  lastFetchedAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
});
export type AgentSkillsGitStatus = typeof AgentSkillsGitStatus.Type;

export const AgentSkillsStatus = Schema.Struct({
  directory: Schema.String,
  exists: Schema.Boolean,
  skills: Schema.Array(AgentSkillEntry),
  /** Null when the directory is not a git repository. */
  git: Schema.NullOr(AgentSkillsGitStatus),
});
export type AgentSkillsStatus = typeof AgentSkillsStatus.Type;

export const AgentSkillsGetStatusInput = Schema.Struct({
  fetch: Schema.optionalKey(Schema.Boolean),
});
export type AgentSkillsGetStatusInput = typeof AgentSkillsGetStatusInput.Type;

export const AgentSkillsInitRepositoryInput = Schema.Struct({
  remoteUrl: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AgentSkillsInitRepositoryInput = typeof AgentSkillsInitRepositoryInput.Type;

export class AgentSkillsError extends Schema.TaggedError<AgentSkillsError>()("AgentSkillsError", {
  operation: Schema.String,
  /** Fixed, user-presentable reason; never raw git output. */
  reason: Schema.String,
}) {
  override get message(): string {
    return `Agent skills ${this.operation} failed: ${this.reason}`;
  }
}
