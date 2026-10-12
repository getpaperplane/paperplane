import {
  ThreadHandoff,
  ThreadHandoffError,
  ForwardCompatibleOptional,
  type ThreadHandoffExportInput,
  type ExecutionEnvironmentDescriptor,
  THREAD_HANDOFF_MAX_BYTES,
  type ThreadHandoffItem,
  type OrchestrationThreadShell,
} from "@rove-code/contracts";
import { portableHandoffText, selectHandoffItems } from "@rove-code/shared/threadHandoff";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";

const workspaceError = (message: string) => new ThreadHandoffError({ kind: "workspace", message });
const isThreadHandoffError = Schema.is(ThreadHandoffError);
const decodeHandoff = Schema.decodeEffect(ThreadHandoff);
const sourceIsBusy = (thread: OrchestrationThreadShell) =>
  thread.session?.status === "starting" ||
  thread.session?.status === "running" ||
  thread.latestTurn?.state === "running" ||
  thread.backgroundLiveness != null ||
  thread.hasPendingApprovals ||
  thread.hasPendingUserInput;
const originalMessageRows = Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String }));
const countRows = Schema.Array(Schema.Struct({ count: Schema.Number, attachments: Schema.Number }));
// Transfer factual outcomes, never arbitrary native state or approval objects.
const ToolOutcome = Schema.Struct({
  command: ForwardCompatibleOptional(Schema.String),
  detail: ForwardCompatibleOptional(Schema.String),
  result: ForwardCompatibleOptional(Schema.String),
  stdout: ForwardCompatibleOptional(Schema.String),
  stderr: ForwardCompatibleOptional(Schema.String),
  status: ForwardCompatibleOptional(Schema.String),
  exitCode: ForwardCompatibleOptional(Schema.Number),
});
const decodeToolOutcome = Schema.decodeUnknownEffect(ToolOutcome);
const encodeToolOutcome = Schema.encodeEffect(Schema.fromJsonString(ToolOutcome));

/** Explicit export reads a bounded recent window plus the original request, never the entire thread. */
export const exportThreadHandoff = Effect.fn("ThreadHandoff.export")(
  function* (input: ThreadHandoffExportInput, environment: ExecutionEnvironmentDescriptor) {
    const query = yield* ProjectionSnapshotQuery;
    const git = yield* GitVcsDriver;
    const sql = yield* SqlClient.SqlClient;
    const before = yield* query.getThreadShellById(input.threadId);
    if (Option.isNone(before) || before.value.projectId === null)
      return yield* workspaceError(
        "Only repository project threads can be continued on another machine.",
      );
    const thread = before.value;
    if (sourceIsBusy(thread))
      return yield* workspaceError(
        "Wait for this thread to finish, or stop it before continuing elsewhere.",
      );
    const project = yield* query.getProjectShellById(thread.projectId);
    const identity = Option.getOrUndefined(project)?.repositoryIdentity;
    if (Option.isNone(project) || !identity)
      return yield* workspaceError(
        "The project needs a shared repository remote before it can be continued.",
      );
    const resolver = yield* RepositoryIdentityResolver;
    const freshIdentity = yield* resolver.resolve(project.value.workspaceRoot, {
      refresh: true,
      preferredRemote: identity.locator.remoteName === "upstream" ? "upstream" : "origin",
    });
    if (
      freshIdentity?.canonicalKey !== identity.canonicalKey ||
      freshIdentity.locator.remoteName !== identity.locator.remoteName
    )
      return yield* workspaceError(
        "The project's remote changed. Refresh the project and prepare a new continuation.",
      );
    const cwd = thread.worktreePath ?? project.value.workspaceRoot;
    const status = yield* git.statusDetailsLocal(cwd);
    if (!status.isRepo || !status.branch)
      return yield* workspaceError("Check out a Git branch before continuing elsewhere.");
    if (thread.branch !== status.branch)
      return yield* workspaceError(
        "The workspace is no longer on this thread's branch. Restore its branch before continuing.",
      );
    if (status.hasWorkingTreeChanges)
      return yield* workspaceError("Commit and push the thread's uncommitted changes first.");
    const branch = status.branch;
    const head = yield* git.resolveCommit({ cwd, revision: "HEAD" });
    const remoteName = identity.locator.remoteName;
    yield* git.fetchRemote({ cwd, remoteName, refName: branch });
    const published = yield* git.resolveRemoteTrackingCommit({
      cwd,
      refName: `${remoteName}/${branch}`,
      fallbackRemoteName: remoteName,
    });
    if (published.commitSha !== head.commitSha)
      return yield* workspaceError(
        `Push '${branch}' to the project's shared remote '${remoteName}' at ${head.commitSha.slice(0, 7)} before continuing. The remote currently differs.`,
      );

    const history = yield* Effect.gen(function* () {
      const snapshot = yield* query.getThreadDetailSnapshot(input.threadId, { turnLimit: 10 });
      if (Option.isNone(snapshot))
        return yield* new ThreadHandoffError({
          kind: "history",
          message:
            "The source conversation could not be loaded. Retry, or explicitly continue with code only.",
        });
      const original =
        yield* sql`SELECT message_id AS id, text FROM projection_thread_messages WHERE thread_id = ${input.threadId} AND role = 'user' AND is_streaming = 0 ORDER BY created_at, message_id LIMIT 1`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(originalMessageRows)),
        );
      const counts =
        yield* sql`SELECT COUNT(*) AS count, COALESCE(SUM(json_array_length(attachments_json)), 0) AS attachments FROM projection_thread_messages WHERE thread_id = ${input.threadId} AND role IN ('user', 'assistant') AND is_streaming = 0`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(countRows)),
        );
      const detail = snapshot.value.thread;
      const messages: ThreadHandoffItem[] = detail.messages.flatMap((message) =>
        message.role === "system" || message.streaming
          ? []
          : [
              {
                id: message.id,
                role: message.role,
                kind: "message",
                text: portableHandoffText(message.text),
              },
            ],
      );
      if (original[0] && !messages.some((item) => item.id === original[0]!.id))
        messages.unshift({
          ...original[0],
          role: "user",
          kind: "message",
          text: portableHandoffText(original[0].text),
        });
      const activity: ThreadHandoffItem[] = [
        ...detail.proposedPlans.map((plan) => ({
          id: String(plan.id),
          role: "assistant" as const,
          kind: "plan",
          text: portableHandoffText(plan.planMarkdown),
        })),
        ...(yield* Effect.forEach(
          detail.activities
            .filter((item) => /^(tool\.|task\.|turn\.failed|worktree\.setup)/.test(item.kind))
            .slice(-20),
          (item) =>
            Effect.gen(function* () {
              const outcome = yield* decodeToolOutcome(item.payload).pipe(
                Effect.orElseSucceed(() => null),
              );
              const renderedOutcome = outcome ? yield* encodeToolOutcome(outcome) : "";
              return {
                id: String(item.id),
                role: "assistant" as const,
                kind: item.kind,
                text: portableHandoffText(`${item.summary}\n\n${renderedOutcome}`),
              };
            }),
        )),
        ...detail.checkpoints.slice(-1).map((checkpoint) => ({
          id: String(checkpoint.checkpointRef),
          role: "assistant" as const,
          kind: "checkpoint",
          text: JSON.stringify(checkpoint),
        })),
      ];
      const items = selectHandoffItems(
        [...activity, ...messages],
        THREAD_HANDOFF_MAX_BYTES - 8_000,
      );
      return {
        items,
        omittedItems:
          Math.max(
            0,
            (counts[0]?.count ?? messages.length) -
              items.filter((item) => item.kind === "message").length,
          ) +
          activity.length -
          items.filter((item) => item.kind !== "message").length,
        omittedAttachments: counts[0]?.attachments ?? 0,
        sequence: snapshot.value.snapshotSequence,
      };
    }).pipe(
      Effect.catch((error) =>
        input.codeOnly
          ? Effect.succeed({ items: [], omittedItems: 0, omittedAttachments: 0, sequence: 0 })
          : Effect.fail(
              new ThreadHandoffError({
                kind: "history",
                message: isThreadHandoffError(error)
                  ? error.message
                  : "Could not export conversation history. Retry, or explicitly continue with code only.",
              }),
            ),
      ),
    );
    const after = yield* query.getThreadShellById(input.threadId);
    const projectAfter = yield* query.getProjectShellById(thread.projectId);
    const identityAfter = yield* resolver.resolve(project.value.workspaceRoot, {
      refresh: true,
      preferredRemote: remoteName === "upstream" ? "upstream" : "origin",
    });
    const currentHead = yield* git.resolveCommit({ cwd, revision: "HEAD" });
    const currentStatus = yield* git.statusDetailsLocal(cwd);
    if (
      Option.isNone(after) ||
      after.value.updatedAt !== thread.updatedAt ||
      after.value.latestTurn?.turnId !== thread.latestTurn?.turnId ||
      sourceIsBusy(after.value) ||
      Option.isNone(projectAfter) ||
      projectAfter.value.workspaceRoot !== project.value.workspaceRoot ||
      identityAfter?.canonicalKey !== identity.canonicalKey ||
      identityAfter.locator.remoteName !== remoteName ||
      currentHead.commitSha !== head.commitSha ||
      currentStatus.branch !== branch ||
      currentStatus.hasWorkingTreeChanges
    )
      return yield* workspaceError(
        "The source changed while preparing the handoff. Retry after the thread and workspace settle.",
      );
    return yield* decodeHandoff({
      version: 1,
      transferId: yield* (yield* Crypto.Crypto).randomUUIDv4,
      sourceEnvironmentId: environment.environmentId,
      sourceThreadId: thread.id,
      sourceLabel: environment.label.slice(0, 512),
      title: thread.title.slice(0, 512),
      repositoryKey: identity.canonicalKey,
      branch,
      commitSha: head.commitSha,
      sourceTurnId: thread.latestTurn?.turnId ?? null,
      sourceSequence: history.sequence,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      codeOnly: input.codeOnly === true,
      items: input.codeOnly ? [] : history.items,
      omittedItems: input.codeOnly
        ? history.items.length + history.omittedItems
        : history.omittedItems,
      omittedAttachments: history.omittedAttachments,
    });
  },
  Effect.mapError((error) =>
    isThreadHandoffError(error)
      ? error
      : workspaceError(
          error instanceof Error ? error.message : "Could not prepare the source workspace.",
        ),
  ),
);
