import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  PiSettings,
  ProviderDriverKind,
} from "@rove-code/contracts";
import { acpRegistryClient } from "@rove-code/provider-acp-registry/client";
import { defineProviderClient, makeProviderClientRegistry } from "@rove-code/provider-core/client";
import { cursorClient } from "@rove-code/provider-cursor/client";
import { grokClient } from "@rove-code/provider-grok/client";
import { museClient } from "@rove-code/provider-muse/client";
import { openCodeClient } from "@rove-code/provider-opencode/client";

// Rove runs Pi in-process through its SDK (ADR 0001), so its client definition
// stays here on Rove's own PiSettings instead of upstream's RPC provider-pi package.
const piClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("pi"),
  label: "Pi",
  badgeLabel: "Early Access",
  settingsSchema: PiSettings,
  icon: {
    viewBox: "165.29 165.29 469.43 469.43",
    fill: { light: "#0F0F0F", dark: "#F5F5F5" },
    paths: [
      {
        d: "M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z",
        fillRule: "evenodd",
      },
      { d: "M517.36 400H634.72V634.72H517.36Z" },
    ],
  },
});

/** The provider client definitions this web build ships, in presentation order. */
export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  cursorClient,
  grokClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: AntigravitySettings,
  },
  museClient,
  piClient,
  acpRegistryClient,
]);
