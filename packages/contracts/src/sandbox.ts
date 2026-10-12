import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SandboxProvider = Schema.Literals(["boat", "modal"]);
export type SandboxProvider = typeof SandboxProvider.Type;
export const SandboxPhase = Schema.Literals(["creating", "running", "paused", "error", "deleting"]);
export const RemoteSandbox = Schema.Struct({
  id: TrimmedNonEmptyString,
  provider: SandboxProvider,
  label: TrimmedNonEmptyString,
  phase: SandboxPhase,
  remoteId: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
  environmentId: Schema.NullOr(EnvironmentId),
  threadId: Schema.NullOr(ThreadId),
});
export type RemoteSandbox = typeof RemoteSandbox.Type;
export const SandboxInventory = Schema.Struct({
  configuredProviders: Schema.Array(SandboxProvider),
  sandboxes: Schema.Array(RemoteSandbox),
});
export type SandboxInventory = typeof SandboxInventory.Type;
export const SandboxConfigureInput = Schema.Struct({
  provider: SandboxProvider,
  // An empty value removes credentials. Never returned to clients.
  token: Schema.String,
  tokenId: Schema.optionalKey(Schema.String),
});
export const SandboxCreateInput = Schema.Struct({
  provider: SandboxProvider,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  confirmCost: Schema.Literal(true),
});
export const SandboxActionInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  action: Schema.Literals(["pause", "resume", "delete", "pair", "forget"]),
  // Resume starts billing; pause interrupts running work; delete is irreversible.
  confirmed: Schema.Literal(true),
});
export const SandboxActionResult = Schema.Struct({
  sandbox: Schema.NullOr(RemoteSandbox),
  pairingUrl: Schema.NullOr(Schema.String),
});
export const SandboxLinkInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export class SandboxError extends Schema.TaggedError<SandboxError>()("SandboxError", {
  message: Schema.String,
}) {}
export const SANDBOX_PORT = 7340;
