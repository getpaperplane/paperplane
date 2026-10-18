import type { EnvironmentId, ThreadId } from "@rove-code/contracts";

import { piExtensionStatusEnvironment } from "../../state/piExtensionStatus";
import { useEnvironmentQuery } from "../../state/query";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

/**
 * Pi extension status lines (what Pi's TUI shows in its footer), as a thread
 * details section. Subscribes only while mounted for a Pi thread; renders
 * nothing while empty, loading, or failed.
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
      <div className="flex flex-col gap-0.5 px-1.5 text-xs">
        {statuses.map(({ key, text }) => (
          <div key={key} title={text} className="truncate text-muted-foreground">
            {text.split("\n")[0]}
          </div>
        ))}
      </div>
    </ThreadDetailsSection>
  );
}
