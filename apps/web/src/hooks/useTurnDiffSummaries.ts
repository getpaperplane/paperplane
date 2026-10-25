import { useMemo } from "react";
import { deriveThreadCheckpointSummaries } from "@getpaperplane/client-runtime/state/thread-checkpoints";
import type { OrchestrationV2ThreadProjection } from "@getpaperplane/contracts";
import { inferCheckpointTurnCountByRunId } from "../session-logic";
import { useStructuralValue } from "./useStructuralValue";
import type { TurnDiffSummary } from "../types";

// Every streamed delta rebuilds the projection, but the summaries only change
// when checkpoints or their assistant messages do. Keeping the previous array
// while it is structurally equal stops downstream timeline work on text-only updates.
export function useTurnDiffSummaries(projection: OrchestrationV2ThreadProjection | null) {
  const derivedTurnDiffSummaries = useMemo<ReadonlyArray<TurnDiffSummary>>(() => {
    if (projection === null) {
      return [];
    }
    return deriveThreadCheckpointSummaries(projection);
  }, [projection]);
  const turnDiffSummaries = useStructuralValue(derivedTurnDiffSummaries);

  const inferredCheckpointTurnCountByRunId = useMemo(
    () => inferCheckpointTurnCountByRunId(turnDiffSummaries),
    [turnDiffSummaries],
  );

  return { turnDiffSummaries, inferredCheckpointTurnCountByRunId };
}
