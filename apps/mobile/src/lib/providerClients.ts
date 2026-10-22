import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  isProviderDriverKind,
  ProviderDriverKind,
} from "@rove-code/contracts";
import { acpRegistryClient } from "@rove-code/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@rove-code/provider-core/client";
import { cursorClient } from "@rove-code/provider-cursor/client";
import { grokClient } from "@rove-code/provider-grok/client";
import { museClient } from "@rove-code/provider-muse/client";
import { openCodeClient } from "@rove-code/provider-opencode/client";
import { piClient } from "@rove-code/provider-pi/client";

/** The provider client definitions this mobile build ships. */
const providerClients = makeProviderClientRegistry([
  { driverKind: ProviderDriverKind.make("codex"), label: "Codex", settingsSchema: CodexSettings },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  cursorClient,
  grokClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: AntigravitySettings,
  },
  museClient,
  openCodeClient,
  piClient,
  acpRegistryClient,
]);

/** The client definition for a driver kind, or `undefined` for drivers drawn by hand. */
export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}

/** Every driver definition this build can configure, in presentation order. */
export const providerClientDefinitions = providerClients.definitions;
