import type { EnvironmentId, RoveProjectFile } from "@getpaperplane/contracts";
import { executeAtomQuery } from "@getpaperplane/client-runtime/state/runtime";

import { getProjectConfigQueryAtom } from "~/hooks/useRoveProjectFileScripts";
import { appAtomRegistry } from "~/rpc/atomRegistry";

/** Read the owning server's accepted project configuration for new-thread defaults. */
export async function readRoveProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<RoveProjectFile | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectConfigQueryAtom(environmentId, workspaceRoot),
    { reportDefect: false, reportFailure: false },
  );
  return result._tag === "Success" && result.value.status === "valid" ? result.value.file : null;
}
