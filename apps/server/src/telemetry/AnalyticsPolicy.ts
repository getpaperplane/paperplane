import {
  ClientConnectionMethod,
  ClientDeviceType,
  ClientOs,
  ClientSurface,
  ClientWebDeployment,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInteractionMode,
  RuntimeMode,
} from "@getpaperplane/contracts";
import * as Schema from "effect/Schema";
import type { AnalyticsService } from "./AnalyticsService.ts";

const AppVersion = Schema.String.check(
  Schema.isMaxLength(80),
  Schema.isPattern(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
);

const ClientProperties = {
  surface: ClientSurface,
  appVersion: AppVersion,
  clientAppVersion: AppVersion,
  clientOs: ClientOs,
  os: Schema.Literals(["iOS", "Android"]),
  clientDeviceType: ClientDeviceType,
  webDeployment: ClientWebDeployment,
  clientBrowser: Schema.Literals([
    "Chrome",
    "Edge",
    "Firefox",
    "Safari",
    "Opera",
    "Samsung Internet",
    "other",
    "unknown",
  ]),
  connectionMethod: ClientConnectionMethod,
  osMajorVersion: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  clientOsMajorVersion: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
} as const;

const Count = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const Label = Schema.String.check(Schema.isMaxLength(160), Schema.isPattern(/^[\w./:+-]+$/));
const ProviderProperties = {
  provider: ProviderDriverKind,
  model: Label,
  effort: Label,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  subscriptionSharing: Schema.Boolean,
} as const;

// Only these metadata keys can leave the server. Do not add command inputs,
// trace attributes or error messages here, even if their names look harmless.
type AnalyticsEventPolicy = Readonly<Record<string, Readonly<Record<string, Schema.Top>>>>;

const EventProperties = {
  "server.boot.heartbeat": { threadCount: Count, projectCount: Count },
  "client.connected": ClientProperties,
  "client.thread.started": ClientProperties,
  "client.turn.requested": ClientProperties,
  "client.feature.used": {
    ...ClientProperties,
    feature: Label,
    action: Label,
    outcome: Schema.Literals(["succeeded", "failed", "cancelled"]),
    durationMs: Count,
  },
  "provider.session.started": {
    ...ProviderProperties,
    hasResumeCursor: Schema.Boolean,
    hasCwd: Schema.Boolean,
    hasModel: Schema.Boolean,
  },
  "provider.session.recovered": {
    ...ProviderProperties,
    strategy: Schema.Literals(["adopt-existing", "resume-thread"]),
    hasResumeCursor: Schema.Boolean,
  },
  "provider.session.stopped": ProviderProperties,
  "provider.sessions.stopped_all": { stoppedSessionCount: Count },
  "provider.runtime_mode.changed": {
    provider: ProviderProperties.provider,
    from: ProviderProperties.runtimeMode,
    to: ProviderProperties.runtimeMode,
  },
  "provider.turn.attempted": ProviderProperties,
  "provider.turn.sent": { ...ProviderProperties, attachmentCount: Count, hasInput: Schema.Boolean },
  "provider.turn.rejected": { ...ProviderProperties, errorType: Label },
  "provider.turn.completed": {
    ...ProviderProperties,
    terminalStatus: Label,
    usageStatus: Schema.Literals(["complete", "partial", "unavailable"]),
    usageScope: Schema.Literal("main_agent"),
    hasSubagents: Schema.Boolean,
    mixedModels: Schema.Boolean,
    durationMs: Count,
    inputTokens: Count,
    cachedInputTokens: Count,
    cacheCreationTokens: Count,
    outputTokens: Count,
    reasoningTokens: Count,
  },
  "provider.turn.interrupted": ProviderProperties,
  "provider.thread.compacted": ProviderProperties,
  "provider.request.responded": { ...ProviderProperties, decision: ProviderApprovalDecision },
  "provider.conversation.rolled_back": { ...ProviderProperties, turns: Count },
  "chatgpt.auth.started": { flow: Label, intent: Label },
  "chatgpt.transfer.started": { flow: Label },
  "chatgpt.auth.completed": {
    flow: Label,
    intent: Label,
    outcome: Label,
    durationMs: Count,
    failureStage: Label,
    connectedAccountCount: Count,
    savedConnectionCount: Count,
  },
  "chatgpt.transfer.completed": {
    flow: Label,
    outcome: Label,
    durationMs: Count,
    failureStage: Label,
    connectedAccountCount: Count,
    savedConnectionCount: Count,
  },
} satisfies AnalyticsEventPolicy;

const validators = new Map(
  Object.entries(EventProperties).map(
    ([event, fields]) =>
      [
        event,
        Object.entries(fields).map(([key, schema]) => [key, Schema.is(schema)] as const),
      ] as const,
  ),
);
const isScalar = Schema.is(Schema.Union([Schema.String, Schema.Number, Schema.Boolean]));

/** Unknown events are dropped; invalid or unapproved properties are omitted. */
export function sanitizeAnalyticsProperties(
  event: string,
  properties: Parameters<AnalyticsService["Service"]["record"]>[1] = {},
) {
  const fields = validators.get(event);
  if (!fields) return undefined;
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, accepts] of fields) {
    const value = properties[key];
    if (isScalar(value) && accepts(value)) safe[key] = value;
  }
  return safe;
}
