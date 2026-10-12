import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@rove-code/client-runtime/environment";
import { CommandId, type ThreadHandoffBacklink } from "@rove-code/contracts";
import { useEffect } from "react";
import { appAtomRegistry } from "./atom-registry";
import { useServerConfigs, useThreadShell } from "./entities";
import { serverEnvironment } from "./server";
import { type QueuedThreadMessage } from "./thread-outbox-model";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";
import {
  completeHandoffBacklink,
  ensureComposerDraftsLoaded,
  handoffBacklinksAtom,
  queueHandoffBacklink,
} from "./use-composer-drafts";
import { useRemoteConnectionStatus } from "./use-remote-environment-registry";

export async function rememberQueuedHandoff(
  message: QueuedThreadMessage,
  ready: boolean,
): Promise<void> {
  const handoff = message.creation?.handoff;
  if (!handoff) return;
  await queueHandoffBacklink({
    transferId: handoff.transferId,
    sourceEnvironmentId: handoff.sourceEnvironmentId,
    sourceThreadId: handoff.sourceThreadId,
    environmentId: message.environmentId,
    threadId: message.threadId,
    environmentLabel:
      appAtomRegistry.get(serverEnvironment.configValueAtom(message.environmentId))?.environment
        .label ?? "another machine",
    createdAt: handoff.createdAt,
    ready,
  });
}

function PendingBacklink({ link }: { link: ThreadHandoffBacklink }) {
  const configs = useServerConfigs();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const target = useThreadShell(scopeThreadRef(link.environmentId, link.threadId));
  const sourceConnected = connectedEnvironments.some(
    (environment) =>
      environment.environmentId === link.sourceEnvironmentId &&
      environment.connectionState === "connected",
  );
  const source = configs.get(link.sourceEnvironmentId);
  const record = useAtomCommand(threadEnvironment.recordContinuation, { reportFailure: false });
  useEffect(() => {
    if (
      !sourceConnected ||
      source?.environment.capabilities.threadContinuationLinks !== true ||
      (!link.ready && !target?.latestTurn)
    )
      return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 1_000;
    const attempt = () => {
      void record({
        environmentId: link.sourceEnvironmentId,
        input: {
          commandId: CommandId.make(`handoff:${link.transferId}:to`),
          threadId: link.sourceThreadId,
          link: {
            direction: "to",
            environmentId: link.environmentId,
            threadId: link.threadId,
            environmentLabel: link.environmentLabel,
            transferId: link.transferId,
          },
          createdAt: link.createdAt,
        },
      }).then((result) => {
        if (result._tag === "Success") completeHandoffBacklink(link.transferId);
        else if (!cancelled) {
          timer = setTimeout(attempt, delay);
          delay = Math.min(delay * 2, 30_000);
        }
      });
    };
    attempt();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [link, sourceConnected, source, target?.latestTurn, record]);
  return null;
}

export function ThreadHandoffBacklinkWorker() {
  useEffect(ensureComposerDraftsLoaded, []);
  const links = useAtomValue(handoffBacklinksAtom);
  return links.map((link) => <PendingBacklink key={link.transferId} link={link} />);
}
