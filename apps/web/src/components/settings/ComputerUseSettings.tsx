import type { ComputerUseControlInput } from "@rove-code/contracts";
import { useEffect, useRef, useState } from "react";

import { computerUseEnvironment } from "~/state/computerUse";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  describeDriver,
  describeVm,
  isMacStatus,
  primaryAction,
  vmActions,
  vmConfirmation,
  vmOf,
} from "./ComputerUseSettings.logic";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

type Action = ComputerUseControlInput["action"];

const PENDING_LABELS = {
  install: "Installing…",
  start: "Checking…",
  "grant-permissions": "Waiting for macOS…",
  "set-telemetry": "Saving…",
  "prepare-vm": "Preparing…",
  "verify-vm": "Verifying…",
  "open-vm-display": "Opening…",
  "release-vm": "Releasing…",
  "remove-vm": "Removing…",
} satisfies Record<Action, string>;

export function ComputerUseSettings() {
  const { scope, environment } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const environmentId =
    environment?.connection.phase === "connected" && environment.serverConfig !== null
      ? environment.environmentId
      : null;
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const driver = useEnvironmentQuery(
    environmentId === null ? null : computerUseEnvironment.status({ environmentId, input: {} }),
  );
  const control = useAtomCommand(computerUseEnvironment.control, "Cua Driver");
  const [pending, setPending] = useState<Action | null>(null);
  const status = driver.data;
  const busy = pending !== null || driver.isPending;
  const vm = vmOf(status);
  const primary = vm === null ? primaryAction(status) : null;
  const telemetry =
    status?.status === "stopped" || status?.status === "running" ? status.telemetry : null;
  const [copied, setCopied] = useState(false);
  // Status depends on the Mac mode, so re-read it when the mode changes here or on another client.
  const refreshDriver = useRef(driver.refresh);
  refreshDriver.current = driver.refresh;
  const macosMode = settings.computerUseMacosMode;
  const shownMode = useRef(macosMode);
  useEffect(() => {
    if (shownMode.current === macosMode) return;
    shownMode.current = macosMode;
    refreshDriver.current();
  }, [macosMode]);

  const run = async (input: ComputerUseControlInput) => {
    if (environmentId === null) return;
    const confirmation = vmConfirmation(input);
    if (confirmation !== null && !window.confirm(confirmation)) return;
    setPending(input.action);
    try {
      await control({ environmentId, input });
    } finally {
      setPending(null);
      driver.refresh();
    }
  };

  return (
    <SettingsSection id="computer-use" title="Computer use">
      <SettingsRow
        {...searchableSetting("agent-computer-use")}
        serverScoped
        settingKeys={["enableAgentComputerUse"]}
        description="Use Cua Driver for background-only app control on Mac and Windows, or a private, offline Linux desktop per thread. Linux apps and files are temporary and cannot access the project or host desktop. Turning this off discards Linux desktops and quits a Mac daemon Rove started."
        control={
          <ScopedSwitch
            settingKeys={["enableAgentComputerUse"]}
            checked={settings.enableAgentComputerUse}
            disabled={projectScope || environmentId === null}
            aria-label="Agent computer use"
            onCheckedChange={(checked) =>
              updateSettings({ enableAgentComputerUse: Boolean(checked) })
            }
          />
        }
      />
      {isMacStatus(status) ? (
        <SettingsRow
          {...searchableSetting("computer-use-macos-mode")}
          serverScoped
          settingKeys={["computerUseMacosMode"]}
          description="The isolated VM runs apps in a private macOS virtual machine, so agents never touch your desktop. Apple Silicon only. Needs about 150 GB of disk."
          control={
            <Select
              value={settings.computerUseMacosMode}
              disabled={projectScope || environmentId === null}
              onValueChange={(value) => {
                if (value !== "host" && value !== "isolated-vm") return;
                updateSettings({ computerUseMacosMode: value });
              }}
            >
              <SelectTrigger aria-label="Mac computer use" className="w-56" size="sm">
                <SelectValue>
                  {settings.computerUseMacosMode === "isolated-vm"
                    ? "Isolated macOS VM"
                    : "This Mac (background)"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="host">This Mac (background)</SelectItem>
                <SelectItem value="isolated-vm">Isolated macOS VM</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
      {status?.status === "stopped" || status?.status === "running" ? (
        vm === null &&
        (status.readiness.platform === "darwin" || status.readiness.platform === "win32") ? (
          <SettingsRow
            {...searchableSetting("computer-use-pixel-input")}
            serverScoped
            settingKeys={["computerUseAllowPixelInput"]}
            description="Lets agents click by screen position. This can briefly change app focus while you work."
            control={
              <ScopedSwitch
                settingKeys={["computerUseAllowPixelInput"]}
                checked={settings.computerUseAllowPixelInput}
                disabled={projectScope || environmentId === null}
                aria-label="Allow pixel input"
                onCheckedChange={(checked) =>
                  updateSettings({ computerUseAllowPixelInput: Boolean(checked) })
                }
              />
            }
          />
        ) : null
      ) : null}
      {vm !== null ? (
        <SettingsRow
          {...searchableSetting("cua-driver")}
          title="macOS VM"
          description={describeVm(vm)}
          control={
            <div className="flex flex-wrap justify-end gap-2">
              {vmActions(vm).map((action, index) => (
                <Button
                  key={action.input.action}
                  size="sm"
                  variant={index === 0 ? "outline" : "ghost"}
                  disabled={busy || environmentId === null}
                  onClick={() => void run(action.input)}
                >
                  {pending === action.input.action ? "Working…" : action.label}
                </Button>
              ))}
            </div>
          }
        >
          {vm.state === "needs-consent" && vm.setupCommand !== undefined ? (
            <div className="flex items-start gap-2">
              <pre className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
                {vm.setupCommand}
              </pre>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(vm.setupCommand ?? "");
                  setCopied(true);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          ) : null}
        </SettingsRow>
      ) : (
        <SettingsRow
          {...searchableSetting("cua-driver")}
          description={describeDriver(status, driver.error)}
          control={
            primary ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void run(primary.input)}
              >
                {pending === primary.input.action
                  ? PENDING_LABELS[primary.input.action]
                  : primary.label}
              </Button>
            ) : status === null ||
              status.status === "runtime-unavailable" ||
              (status.status === "running" && status.readiness.platform === "linux") ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || environmentId === null}
                onClick={driver.refresh}
              >
                {driver.isPending ? "Checking…" : "Check again"}
              </Button>
            ) : null
          }
        />
      )}
      {telemetry !== null && vm === null ? (
        <SettingsRow
          {...searchableSetting("cua-telemetry")}
          description="Cua collects a pseudonymous installation ID and content-free usage counts, never prompts, screen contents, or file paths. Rove turns this off when it installs Cua."
          control={
            <Switch
              checked={telemetry}
              disabled={busy}
              aria-label="Share usage data with Cua"
              onCheckedChange={(checked) =>
                void run({ action: "set-telemetry", enabled: Boolean(checked) })
              }
            />
          }
        />
      ) : null}
    </SettingsSection>
  );
}
