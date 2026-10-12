import { createSandboxEnvironmentAtoms } from "@rove-code/client-runtime/state/sandbox";
import { connectionAtomRuntime } from "../connection/runtime";

export const sandboxEnvironment = createSandboxEnvironmentAtoms(connectionAtomRuntime);
