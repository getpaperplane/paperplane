import type { EnvironmentId, ThreadId } from "@getpaperplane/contracts";
import { PuzzleIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { piExtensionStatusEnvironment } from "../../state/piExtensionStatus";
import { useEnvironmentQuery } from "../../state/query";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./threadDetailsPanelStyles";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

/**
 * Pi extension status lines (what Pi's TUI shows in its footer), one read-only
 * row per extension status key in the thread details card. Subscribes only while
 * mounted for a Pi thread; renders nothing while empty, loading, or failed.
 */
export function PiExtensionStatus({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const query = useEnvironmentQuery(
    piExtensionStatusEnvironment.snapshot({ environmentId, input: { threadId } }),
  );
  const statuses = query.isSuccess ? (query.data?.statuses ?? []) : [];
  if (statuses.length === 0) return null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-pi-extension-status-heading"
      title="Extension status"
      showHeading={false}
      data-pi-extension-status="true"
    >
      <ul className="flex flex-col">
        {statuses.map(({ key, text }) => (
          <Tooltip key={key}>
            <TooltipTrigger
              render={
                <li className={cn("flex items-center", THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS)} />
              }
            >
              <PuzzleIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
              <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
                {text.split("\n")[0]}
              </span>
            </TooltipTrigger>
            <TooltipPopup>
              <span className="whitespace-pre-wrap">{`${key}\n${text}`}</span>
            </TooltipPopup>
          </Tooltip>
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}
