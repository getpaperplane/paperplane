import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const PiCatalogInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type PiCatalogInput = typeof PiCatalogInput.Type;

export const PiCatalogExtensionInfo = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  source: Schema.String,
  scope: Schema.Literals(["user", "project", "temporary"]),
  tools: Schema.Array(Schema.String),
  commands: Schema.Array(Schema.String),
});
export type PiCatalogExtensionInfo = typeof PiCatalogExtensionInfo.Type;

export const PiCatalogSnapshot = Schema.Struct({
  extensions: Schema.Array(PiCatalogExtensionInfo),
  modelProviders: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      authenticated: Schema.Boolean,
      modelCount: Schema.Number,
    }),
  ),
  warnings: Schema.Array(Schema.String),
  compatibilityWarnings: Schema.optional(Schema.Array(Schema.String)),
});
export type PiCatalogSnapshot = typeof PiCatalogSnapshot.Type;

export class PiCatalogError extends Schema.TaggedError<PiCatalogError>()("PiCatalogError", {
  message: Schema.String,
}) {}

export const PiExtensionStatusesSubscribeInput = Schema.Struct({ threadId: ThreadId });
export type PiExtensionStatusesSubscribeInput = typeof PiExtensionStatusesSubscribeInput.Type;

/** Bounded, ephemeral status lines for one subscribed thread, not transcript history. */
export const PiExtensionStatusSnapshot = Schema.Struct({
  statuses: Schema.Array(
    Schema.Struct({
      key: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
      text: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
    }),
  ).check(Schema.isMaxLength(64)),
}).check(
  Schema.makeFilter(
    (snapshot) =>
      snapshot.statuses.reduce(
        (length, status) => length + status.key.length + status.text.length,
        0,
      ) <= 8192,
  ),
);
export type PiExtensionStatusSnapshot = typeof PiExtensionStatusSnapshot.Type;
