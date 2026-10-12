import { scopeProjectRef, scopeThreadRef } from "@rove-code/client-runtime/environment";
import { squashAtomCommandFailure } from "@rove-code/client-runtime/state/runtime";
import {
  CommandId,
  ThreadHandoffError,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@rove-code/contracts";
import { useCallback, useMemo, useRef } from "react";
import * as Schema from "effect/Schema";

const isThreadHandoffError = Schema.is(ThreadHandoffError);

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import { type HandoffTarget, resolveHandoffTargets } from "../lib/threadHandoff";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject, readProjects, readThreadShell } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useThreadHandoffStore } from "../threadHandoffStore";
import { threadKey } from "@rove-code/client-runtime/state/entities";
import { useNewThreadHandler } from "./useHandleNewThread";

function readEnvironments() {
  return new Map(
    [...appAtomRegistry.get(environmentServerConfigsAtom)].map(([environmentId, config]) => [
      environmentId,
      {
        label: config.environment.label,
        supportsCheckoutBaseBranch:
          config.environment.capabilities.worktreeCheckoutBaseBranch === true,
        supportsPortableHandoff: config.environment.capabilities.threadPortableHandoff === true,
      },
    ]),
  );
}

/** No agent runs until the destination draft is reviewed and sent. */
export function useContinueThreadOnEnvironment() {
  const handleNewThread = useNewThreadHandler();
  const inFlight = useRef(new Set<string>());
  const exportHandoff = useAtomCommand(threadEnvironment.exportHandoff, { reportFailure: false });
  const resolveTargets = useCallback((threadRef: ScopedThreadRef): ReadonlyArray<HandoffTarget> => {
    const thread = readThreadShell(threadRef);
    if (
      !thread?.projectId ||
      !thread.branch ||
      !readEnvironments().get(thread.environmentId)?.supportsPortableHandoff
    )
      return [];
    const source = readProject(scopeProjectRef(thread.environmentId, thread.projectId));
    return source
      ? resolveHandoffTargets({
          source,
          projects: readProjects(),
          environments: readEnvironments(),
        })
      : [];
  }, []);
  const continueOn = useCallback(
    async function continueOn(
      threadRef: ScopedThreadRef,
      target: HandoffTarget,
      codeOnly = false,
    ): Promise<void> {
      const key = threadKey(threadRef);
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      try {
        const result = await exportHandoff({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, ...(codeOnly ? { codeOnly: true } : {}) },
        });
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: `Can't continue on ${target.label} yet`,
              description:
                error instanceof Error ? error.message : "Could not prepare the source thread.",
              actionProps: {
                children: "Retry",
                onClick: () => void continueOn(threadRef, target, codeOnly),
              },
              ...(isThreadHandoffError(error) && error.kind === "history"
                ? {
                    data: {
                      secondaryActionProps: {
                        children: "Continue with code only",
                        onClick: () => void continueOn(threadRef, target, true),
                      },
                    },
                  }
                : {}),
            }),
          );
          return;
        }
        const handoff = result.value;
        const opened = await handleNewThread(
          scopeProjectRef(target.environmentId, target.projectId),
          {
            branch: `${target.remoteName}/${handoff.branch}`,
            worktreePath: null,
            envMode: "worktree",
            startFromOrigin: false,
          },
        );
        if (!opened) return;
        useComposerDraftStore.getState().setDraftThreadContext(opened.draftId, {
          handoff,
          checkoutBaseBranch: true,
          environmentSelection: "manual",
        });
        useComposerDraftStore
          .getState()
          .setPrompt(
            opened.draftId,
            "Review the branch and continue where the original thread left off.",
          );
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Could not save continuation draft",
            description: error instanceof Error ? error.message : "The draft could not be saved.",
          }),
        );
      } finally {
        inFlight.current.delete(key);
      }
    },
    [exportHandoff, handleNewThread],
  );
  return useMemo(() => ({ resolveTargets, continueOn }), [resolveTargets, continueOn]);
}

/** Stable command ids make retries safe; destination provenance is already persisted by the server. */
export function useRecordThreadHandoff() {
  const recordContinuation = useAtomCommand(threadEnvironment.recordContinuation, {
    reportFailure: false,
  });
  return useCallback(
    async (target: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }) => {
      const key = threadKey(target);
      const pending = useThreadHandoffStore.getState().pending[key];
      if (!pending) return true;
      if (
        !pending.ready &&
        !readThreadShell(scopeThreadRef(target.environmentId, target.threadId))?.latestTurn
      )
        return false;
      const destination = readEnvironments().get(target.environmentId);
      if (
        !destination ||
        !readEnvironments().get(pending.handoff.sourceEnvironmentId)?.supportsPortableHandoff
      )
        return false;
      const result = await recordContinuation({
        environmentId: pending.handoff.sourceEnvironmentId,
        input: {
          commandId: CommandId.make(`handoff:${pending.handoff.transferId}:to`),
          threadId: pending.handoff.sourceThreadId,
          link: {
            direction: "to",
            environmentId: target.environmentId,
            threadId: target.threadId,
            environmentLabel: destination.label,
            transferId: pending.handoff.transferId,
          },
          createdAt: pending.handoff.createdAt,
        },
      });
      if (result._tag === "Success") useThreadHandoffStore.getState().complete(key);
      return result._tag === "Success";
    },
    [recordContinuation],
  );
}
