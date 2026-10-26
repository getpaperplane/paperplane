import { scopeThreadRef } from "@getpaperplane/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadEnvironmentLink,
  type ThreadId,
} from "@getpaperplane/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowDownLeftIcon, ArrowRightIcon, ArrowUpRightIcon, XIcon } from "lucide-react";

import { useClientSettings } from "../../hooks/useSettings";
import { useThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Links between a thread and its continuation on another environment, shown in
 * the thread details panel next to Lineage. Renders nothing when neither exists.
 */
export function ThreadContinuationPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const thread = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const continuedFrom = thread?.continuedFrom ?? null;
  const continuedOn = thread?.continuedOn ?? null;
  if (continuedFrom === null && continuedOn === null) return null;

  // Clearing it on the server removes the link from every client.
  const removeContinuedOn = () => {
    void updateThreadMetadata({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, continuedOn: null },
    }).then((result) => {
      if (result._tag === "Failure") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not remove the link",
            description: "Check the connection and try again.",
          }),
        );
      }
    });
  };

  return (
    <ThreadDetailsSection headingId="thread-details-continuation-heading" title="Continuation">
      <ul aria-label="Continued threads" className="m-0 list-none p-0">
        {continuedFrom ? <ContinuationRow direction="from" link={continuedFrom} /> : null}
        {continuedOn ? (
          <ContinuationRow
            direction="on"
            link={continuedOn}
            onRemove={canOperate ? removeContinuedOn : undefined}
          />
        ) : null}
      </ul>
    </ThreadDetailsSection>
  );
}

function ContinuationRow({
  direction,
  link,
  onRemove,
}: {
  readonly direction: "from" | "on";
  readonly link: ThreadEnvironmentLink;
  readonly onRemove?: (() => void) | undefined;
}) {
  const environment = useEnvironment(link.environmentId);
  const navigate = useNavigate();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const connected =
    environment !== null &&
    environment.connection.phase === "connected" &&
    environment.serverConfig !== null;
  const label = environment?.label.trim() || link.environmentLabel;
  const DirectionIcon = direction === "from" ? ArrowDownLeftIcon : ArrowUpRightIcon;
  const summary = `Continued ${direction} ${label} · ${formatDayAwareTimestamp(link.at, timestampFormat)}`;
  const trailingVisibilityClass = onRemove
    ? "group-hover:opacity-0 group-focus-within:opacity-0 pointer-coarse:opacity-0 [@media(hover:none)]:opacity-0"
    : "";
  const open = () => {
    if (!connected) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(link.environmentId, link.threadId)),
    });
  };

  return (
    <li className="group relative flex h-8 items-center rounded-lg">
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part="row"
              aria-label={`${link.title}, continued ${direction} ${label}`}
              // aria-disabled rather than disabled, so the tooltip still explains why.
              aria-disabled={!connected}
              onClick={open}
            />
          }
        >
          <DirectionIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          {/* The other side usually shares this thread's title, so the machine leads. */}
          <span className="min-w-0 flex-1 truncate text-left text-sm font-medium leading-4 text-foreground/85">
            {label}
          </span>
          {connected ? (
            <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          ) : null}
          <span className={`shrink-0 text-2xs text-muted-foreground ${trailingVisibilityClass}`}>
            {direction === "from" ? "source" : "continued"}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="left">
          <span className="block">{summary}</span>
          <span className="block text-muted-foreground">“{link.title}”</span>
          {direction === "on" ? (
            <span className="block text-muted-foreground">
              New messages here start a separate conversation.
            </span>
          ) : null}
          {!connected ? (
            <span className="block text-muted-foreground">{label} is not connected.</span>
          ) : null}
        </TooltipPopup>
      </Tooltip>
      {onRemove ? (
        <div className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  aria-label={`Remove link to ${label}`}
                  onClick={onRemove}
                />
              }
            >
              <XIcon aria-hidden className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="left">Remove link</TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
    </li>
  );
}
