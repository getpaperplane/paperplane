import { scopeThreadRef } from "@rove-code/client-runtime/environment";
import { useEffect } from "react";
import { useServerConfigs, useThreadShell } from "../state/entities";
import { useThreadHandoffStore, type PendingThreadHandoff } from "../threadHandoffStore";
import { useRecordThreadHandoff } from "../hooks/useContinueThreadOnEnvironment";

function PendingBacklink({ pending }: { pending: PendingThreadHandoff }) {
  const target = useThreadShell(scopeThreadRef(pending.environmentId, pending.threadId));
  const configs = useServerConfigs();
  const source = configs.get(pending.handoff.sourceEnvironmentId);
  const destination = configs.get(pending.environmentId);
  const record = useRecordThreadHandoff();
  useEffect(() => {
    if (!source || !destination || (!pending.ready && !target?.latestTurn)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 1_000;
    const attempt = () => {
      void record(pending).then((done) => {
        if (cancelled || done) return;
        timer = setTimeout(attempt, delay);
        delay = Math.min(delay * 2, 30_000);
      });
    };
    attempt();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [source, destination, pending, target?.latestTurn, record]);
  return null;
}

/** Reconnect/reload recovery does not depend on reopening the source or destination chat. */
export function ThreadHandoffReconciler() {
  const pending = useThreadHandoffStore((state) => state.pending);
  return Object.entries(pending).map(([key, value]) => (
    <PendingBacklink key={key} pending={value} />
  ));
}
