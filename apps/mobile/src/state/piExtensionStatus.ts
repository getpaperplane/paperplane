import { createPiExtensionStatusAtoms } from "@rove-code/client-runtime/state/pi-extension-status";

import { connectionAtomRuntime } from "../connection/runtime";

export const piExtensionStatusEnvironment = createPiExtensionStatusAtoms(connectionAtomRuntime);
