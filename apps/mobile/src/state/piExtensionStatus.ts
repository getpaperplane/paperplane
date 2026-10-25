import { createPiExtensionStatusAtoms } from "@getpaperplane/client-runtime/state/pi-extension-status";

import { connectionAtomRuntime } from "../connection/runtime";

export const piExtensionStatusEnvironment = createPiExtensionStatusAtoms(connectionAtomRuntime);
