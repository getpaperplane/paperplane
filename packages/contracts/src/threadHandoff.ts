import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  ThreadId,
  TurnId,
  MessageId,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const THREAD_HANDOFF_ACTIVITY_KIND = "thread.handoff";
export const THREAD_HANDOFF_MAX_BYTES = 128_000;
export const HandoffCommit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/));

export const ThreadHandoffItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  role: Schema.Literals(["user", "assistant"]),
  kind: TrimmedNonEmptyString,
  text: Schema.String.check(Schema.isMaxLength(THREAD_HANDOFF_MAX_BYTES)),
});
export type ThreadHandoffItem = typeof ThreadHandoffItem.Type;

/** Portable context, never provider credentials, native tool state, or permission grants. */
export const ThreadHandoff = Schema.Struct({
  version: Schema.Literal(1),
  transferId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  sourceLabel: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  repositoryKey: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  branch: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  commitSha: HandoffCommit,
  sourceTurnId: Schema.NullOr(TurnId),
  sourceSequence: NonNegativeInt,
  createdAt: IsoDateTime,
  codeOnly: Schema.optionalKey(Schema.Boolean),
  items: Schema.Array(ThreadHandoffItem).check(Schema.isMaxLength(64)),
  omittedItems: NonNegativeInt,
  omittedAttachments: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <= THREAD_HANDOFF_MAX_BYTES ||
      "Handoff exceeds its transfer budget",
  ),
);
export type ThreadHandoff = typeof ThreadHandoff.Type;

export const ThreadHandoffBacklink = Schema.Struct({
  transferId: TrimmedNonEmptyString,
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  environmentLabel: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  ready: Schema.Boolean,
});
export type ThreadHandoffBacklink = typeof ThreadHandoffBacklink.Type;

export const ImportedThreadHandoff = Schema.Struct({
  handoff: ThreadHandoff,
  messageId: MessageId,
});
export type ImportedThreadHandoff = typeof ImportedThreadHandoff.Type;

export const ThreadHandoffExportInput = Schema.Struct({
  threadId: ThreadId,
  codeOnly: Schema.optional(Schema.Boolean),
});
export type ThreadHandoffExportInput = typeof ThreadHandoffExportInput.Type;

export class ThreadHandoffError extends Schema.TaggedError<ThreadHandoffError>()(
  "ThreadHandoffError",
  {
    kind: Schema.Literals(["workspace", "history"]),
    message: Schema.String,
  },
) {}
