import { AuthSettingsWriteScope, ENVIRONMENT_MACHINE_KINDS } from "@rove-code/contracts";
import type { EnvironmentId, ServerConfig } from "@rove-code/contracts";
import {
  detectedEnvironmentMachineKind,
  planEnvironmentIconSetting,
  resolveEnvironmentIconPickerLock,
} from "@rove-code/client-runtime/environment-admin";
import { resolveEnvironmentMachineKind } from "@rove-code/contracts";

import { AppText as Text } from "../../../components/ui/AppText";
import { ENVIRONMENT_MACHINE_KIND_LABELS } from "../../../components/EnvironmentMachineSymbol";
import { serverEnvironment } from "../../../state/server";
import { useEnvironmentScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsChoiceRow } from "./SettingsChoiceRow";
import { SettingsSection } from "./SettingsSection";

/**
 * Icon override for an environment. Choosing the detected kind clears the
 * override, so it doubles as reset.
 */
export function EnvironmentIconSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: ServerConfig | null;
}) {
  const canWrite = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "environment icon update",
    reportFailure: true,
  });
  const lock = resolveEnvironmentIconPickerLock({
    serverConfig: props.serverConfig,
    operateAccess: canWrite ? "granted" : "denied",
  });
  const detected = detectedEnvironmentMachineKind(props.serverConfig);
  const resolved = resolveEnvironmentMachineKind(props.serverConfig);
  return (
    <SettingsSection title="Icon" footer={lock ?? undefined}>
      {ENVIRONMENT_MACHINE_KINDS.map((kind, index) => (
        <SettingsChoiceRow
          key={kind}
          label={ENVIRONMENT_MACHINE_KIND_LABELS[kind]}
          description={
            kind === detected
              ? props.serverConfig?.environment.platform.machine
                ? "Detected. Choosing this resets the icon."
                : "Default. Choosing this resets the icon."
              : undefined
          }
          selected={kind === resolved}
          separated={index > 0}
          disabled={lock !== null}
          onPress={() => {
            const environmentIcon = planEnvironmentIconSetting(props.serverConfig, kind);
            if (lock !== null || environmentIcon === undefined) return;
            void updateSettings({
              environmentId: props.environmentId,
              input: { patch: { environmentIcon } },
            });
          }}
        />
      ))}
    </SettingsSection>
  );
}
