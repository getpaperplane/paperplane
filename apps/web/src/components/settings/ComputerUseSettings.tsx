import { ComputerUseControlError, type ComputerUseControlInput } from "@rove-code/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@rove-code/client-runtime/state/runtime";
import { CheckIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { computerUseEnvironment } from "~/state/computerUse";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  controlFailureTitle,
  describeDriver,
  describeVm,
  isRemoveAction,
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
  const control = useAtomCommand(computerUseEnvironment.control, {
    label: "Cua Driver",
    reportFailure: false,
  });
  const [pending, setPending] = useState<Action | null>(null);
  const status = driver.data;
  const busy = pending !== null || driver.isPending;
  const vm = vmOf(status);
  const primary = vm === null ? primaryAction(status) : null;
  const telemetry =
    status?.status === "stopped" || status?.status === "running" ? status.telemetry : null;
  const [copied, setCopied] = useState(false);
  const copiedTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimeout.current !== null) clearTimeout(copiedTimeout.current);
    },
    [],
  );
  const copySetup = (text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    if (copiedTimeout.current !== null) clearTimeout(copiedTimeout.current);
    copiedTimeout.current = setTimeout(() => setCopied(false), 2000);
  };
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
      const result = await control({ environmentId, input });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: controlFailureTitle(input.action),
          description:
            error instanceof ComputerUseControlError && error.detail.length > 0
              ? error.detail
              : error instanceof Error
                ? error.message
                : "The operation failed.",
        });
      }
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
                  variant={
                    isRemoveAction(action.input)
                      ? "destructive-outline"
                      : index === 0
                        ? "outline"
                        : "ghost"
                  }
                  disabled={busy || environmentId === null}
                  onClick={() => void run(action.input)}
                >
                  {pending === action.input.action
                    ? PENDING_LABELS[action.input.action]
                    : action.label}
                </Button>
              ))}
            </div>
          }
        >
          {vm.state === "needs-consent" && vm.setupCommand !== undefined ? (
            <div className="pt-1 pb-2">
              <Collapsible>
                <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                  <ChevronRightIcon
                    aria-hidden
                    className="size-3 shrink-0 transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none"
                  />
                  <span className="font-medium text-foreground">Manual setup</span>
                  <span>If automatic setup didn't finish</span>
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <div className="space-y-2 pt-2">
                    <ol className="list-decimal space-y-0.5 pl-8 text-xs text-muted-foreground">
                      <li>Open the VM and launch Terminal.</li>
                      <li>Paste and run this script.</li>
                      <li>Approve the Accessibility and Screen Recording prompts.</li>
                      <li>Select Verify.</li>
                    </ol>
                    <div className="relative">
                      <pre className="max-h-48 overflow-auto rounded-lg border border-border bg-muted/40 py-2 pr-10 pl-3 font-mono text-xs">
                        {vm.setupCommand}
                      </pre>
                      <Button
                        className="absolute top-1.5 right-1.5"
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={copied ? "Copied" : "Copy setup script"}
                        onClick={() => copySetup(vm.setupCommand ?? "")}
                      >
                        {copied ? <CheckIcon /> : <CopyIcon />}
                      </Button>
                    </div>
                  </div>
                </CollapsiblePanel>
              </Collapsible>
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
