import type { EnvironmentId, ThreadId } from "@rove-code/contracts";

import { piExtensionStatusEnvironment } from "../../state/piExtensionStatus";
import { useEnvironmentQuery } from "../../state/query";

/**
 * Pi extension status lines (what Pi's TUI shows above its editor). Subscribes
 * only while mounted for a Pi thread; renders nothing while empty, loading, or failed.
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
    <div data-pi-extension-status="true" className="space-y-0.5 px-3 pb-1.5 text-xs">
      {statuses.map(({ key, text }) => (
        <div key={key} title={text} className="truncate text-muted-foreground/75">
          {text.split("\n")[0]}
        </div>
      ))}
    </div>
  );
}
