import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectConfigState } from "@getpaperplane/contracts";
import { resolveProjectConfigState } from "@getpaperplane/client-runtime/project-config";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { useFilesystemReadAccess } from "~/state/filesystem";
import { projectEnvironment } from "~/state/projects";

const EMPTY_CONFIG_QUERY = Atom.make(AsyncResult.initial<ProjectConfigState, never>(false));

export function getProjectConfigQueryAtom(environmentId: EnvironmentId, cwd: string) {
  return projectEnvironment.readConfig({ environmentId, input: { cwd } });
}

/** Server-decoded paperplane.json state, including a filename-only legacy notice. */
export function usePaperplaneProjectFileState(environmentId: EnvironmentId, cwd: string | null) {
  const access = useFilesystemReadAccess(environmentId);
  const result = useAtomValue(
    cwd !== null && access.canReadFiles
      ? getProjectConfigQueryAtom(environmentId, cwd)
      : EMPTY_CONFIG_QUERY,
  );
  return resolveProjectConfigState(
    cwd !== null && access.canReadFiles ? Option.getOrNull(AsyncResult.value(result)) : null,
    cwd !== null && (access.isPending || result.waiting),
  );
}
