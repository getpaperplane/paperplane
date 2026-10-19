import {
  createComputerUseEnvironmentAtoms,
  EMPTY_COMPUTER_DESKTOPS_STATE,
} from "@rove-code/client-runtime/state/computer-use";
import type { ComputerDesktopsState, EnvironmentId } from "@rove-code/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const computerUseEnvironment = createComputerUseEnvironmentAtoms(connectionAtomRuntime);

/** Private computer desktops for one environment, pushed by the server. */
export function useComputerDesktops(environmentId: EnvironmentId | null) {
  const query = useEnvironmentQuery(
    environmentId === null ? null : computerUseEnvironment.desktops({ environmentId, input: {} }),
  );
  const state: ComputerDesktopsState = query.data ?? EMPTY_COMPUTER_DESKTOPS_STATE;
  return { state, loaded: query.data !== undefined };
}
