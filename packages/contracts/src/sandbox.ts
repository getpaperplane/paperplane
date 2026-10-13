import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SandboxProvider = Schema.Literals(["boat", "modal"]);
export type SandboxProvider = typeof SandboxProvider.Type;
/**
 * Sign-ins the managing environment can copy into a sandbox, so agents there
 * run on the user's existing subscriptions instead of a fresh login.
 */
export const SandboxCredentialKind = Schema.Literals([
  "codex",
  "claude",
  "pi",
  "opencode",
  "github",
]);
export type SandboxCredentialKind = typeof SandboxCredentialKind.Type;
/** Modal container regions. Absent means Modal's default (US) without a regional surcharge. */
export const SandboxRegion = Schema.Literals(["us", "eu", "ap"]);
export type SandboxRegion = typeof SandboxRegion.Type;
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
  // Optional for sandboxes saved by, and inventories sent from, older servers.
  credentials: Schema.optionalKey(Schema.Array(SandboxCredentialKind)),
  region: Schema.optionalKey(SandboxRegion),
});
export type RemoteSandbox = typeof RemoteSandbox.Type;
export const SandboxInventory = Schema.Struct({
  configuredProviders: Schema.Array(SandboxProvider),
  sandboxes: Schema.Array(RemoteSandbox),
  /** Sign-ins found on the managing environment. Absent on servers that can't forward them. */
  availableCredentials: Schema.optionalKey(Schema.Array(SandboxCredentialKind)),
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
  credentials: Schema.optionalKey(Schema.Array(SandboxCredentialKind)),
  region: Schema.optionalKey(SandboxRegion),
});
export const SandboxActionInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  action: Schema.Literals(["pause", "resume", "delete", "pair", "forget", "credentials"]),
  /** The full set of sign-ins to keep in the sandbox; required by `credentials`. */
  credentials: Schema.optionalKey(Schema.Array(SandboxCredentialKind)),
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
/**
 * Rove in a sandbox serves from this bootstrap-owned workspace (see the server's
 * sandbox bootstrap), which lets clients recognize sandbox environments, and
 * pick a clone destination, without asking the managing environment.
 */
const SANDBOX_WORKSPACE_DIR = ".rove-sandbox/workspace";
export function isRemoteSandboxWorkspace(cwd: string): boolean {
  return cwd.replace(/\/+$/, "").endsWith(`/${SANDBOX_WORKSPACE_DIR}`);
}
