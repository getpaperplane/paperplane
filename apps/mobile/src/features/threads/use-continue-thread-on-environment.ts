import { useNavigation } from "@react-navigation/native";
import { resolveHandoffTargets, type HandoffTarget } from "@rove-code/client-runtime/threadHandoff";
import { squashAtomCommandFailure } from "@rove-code/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@rove-code/client-runtime/state/shell";
import { ThreadHandoffError } from "@rove-code/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useRef } from "react";
import { Alert } from "react-native";
import { useProjects, useServerConfigs } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  createNewTaskDraft,
  flushComposerDrafts,
  setComposerDraftText,
  updateComposerDraftSettings,
} from "../../state/use-composer-drafts";

const isThreadHandoffError = Schema.is(ThreadHandoffError);

/** Mobile supplies navigation and persistence; export and target policy are shared with web. */
export function useContinueThreadOnEnvironment() {
  const projects = useProjects();
  const configs = useServerConfigs();
  const navigation = useNavigation();
  const exportHandoff = useAtomCommand(threadEnvironment.exportHandoff, { reportFailure: false });
  const inFlight = useRef(new Set<string>());
  const resolveTargets = useCallback(
    (thread: EnvironmentThreadShell) => {
      const source = projects.find(
        (project) =>
          project.environmentId === thread.environmentId && project.id === thread.projectId,
      );
      if (
        !source ||
        !thread.branch ||
        configs.get(thread.environmentId)?.environment.capabilities.threadPortableHandoff !== true
      )
        return [];
      return resolveHandoffTargets({
        source,
        projects,
        environments: new Map(
          [...configs].map(([id, config]) => [
            id,
            {
              label: config.environment.label,
              supportsCheckoutBaseBranch:
                config.environment.capabilities.worktreeCheckoutBaseBranch === true,
              supportsPortableHandoff:
                config.environment.capabilities.threadPortableHandoff === true,
            },
          ]),
        ),
      });
    },
    [projects, configs],
  );
  const continueOn = useCallback(
    async function continueOn(
      thread: EnvironmentThreadShell,
      target: HandoffTarget,
      codeOnly = false,
    ): Promise<void> {
      const key = `${thread.environmentId}:${thread.id}`;
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      try {
        const result = await exportHandoff({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, ...(codeOnly ? { codeOnly: true } : {}) },
        });
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          Alert.alert(
            `Can't continue on ${target.label} yet`,
            error instanceof Error ? error.message : "Could not prepare the thread.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Retry", onPress: () => void continueOn(thread, target, codeOnly) },
              ...(isThreadHandoffError(error) && error.kind === "history"
                ? [
                    {
                      text: "Continue with code only",
                      onPress: () => void continueOn(thread, target, true),
                    },
                  ]
                : []),
            ],
          );
          return;
        }
        const draftId = createNewTaskDraft({
          environmentId: target.environmentId,
          projectId: target.projectId,
        });
        updateComposerDraftSettings(draftId, {
          handoff: result.value,
          workspaceSelection: {
            mode: "worktree",
            branch: `${target.remoteName}/${result.value.branch}`,
            worktreePath: null,
            startFromOrigin: false,
          },
        });
        setComposerDraftText(
          draftId,
          "Review the branch and continue where the original thread left off.",
        );
        await flushComposerDrafts();
        navigation.navigate("NewTaskSheet", { screen: "NewTaskDraft", params: { draftId } });
      } catch (error) {
        Alert.alert(
          "Could not save continuation draft",
          error instanceof Error ? error.message : "The draft could not be saved.",
        );
      } finally {
        inFlight.current.delete(key);
      }
    },
    [exportHandoff, navigation],
  );
  return { resolveTargets, continueOn };
}
