import { useShallow } from "zustand/react/shallow";
import { useComposerDraftStore, type ComposerThreadDraftState } from "../../composerDraftStore";

// The active row uses its route-entry snapshot. Neither its keystrokes nor
// edits to real-thread composers can change any of the live draft rows.
export function useSidebarDraftComposers(
  routeDraftId: string | null,
  scopedProjectKeys: ReadonlySet<string> | null,
) {
  return useComposerDraftStore(
    useShallow((store) => {
      const composers: Record<string, ComposerThreadDraftState> = {};
      for (const [key, session] of Object.entries(store.draftThreadsByThreadKey)) {
        if (
          key === routeDraftId ||
          session.promotedTo != null ||
          (scopedProjectKeys !== null &&
            !scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`))
        ) {
          continue;
        }
        const composer = store.draftsByThreadKey[key];
        if (composer) composers[key] = composer;
      }
      return composers;
    }),
  );
}
