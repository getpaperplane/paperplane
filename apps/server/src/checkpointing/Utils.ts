import * as Base64Url from "effect/encoding/Base64Url";
import { CheckpointRef, ProjectId, type ThreadId } from "@getpaperplane/contracts";

import { ROVE_CHECKPOINT_REFS_PREFIX } from "@getpaperplane/shared/roveMigration";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${ROVE_CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(threadId)}/turn/${turnCount}`,
  );
}

function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId | null;
    readonly worktreePath: string | null;
    readonly workspacePath?: string | null | undefined;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  if (input.thread.projectId === null) {
    return input.thread.workspacePath ?? undefined;
  }
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}
