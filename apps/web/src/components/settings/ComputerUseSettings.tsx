import {
  ComputerUseControlError,
  type ComputerUseControlInput,
  type ComputerUseMacosVm,
} from "@rove-code/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@rove-code/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { CheckIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { computerUseEnvironment } from "~/state/computerUse";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Progress } from "../ui/progress";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  controlFailureTitle,
  describeDriver,
  describeVm,
  describeVmProgress,
  isDiskBlocked,
  isRemoveAction,
  isMacStatus,
  primaryAction,
  vmActions,
  vmConfirmation,
  vmOf,
  vmSetupStep,
  VM_SETUP_STEPS,
} from "./ComputerUseSettings.logic";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { VmSetupDesktopDialog } from "./VmSetupDesktopDialog";

type Action = ComputerUseControlInput["action"];

const isControlError = Schema.is(ComputerUseControlError);

const PENDING_LABELS = {
  install: "Installing…",
  start: "Checking…",
  "grant-permissions": "Waiting for macOS…",
  "set-telemetry": "Saving…",
  "prepare-vm": "Starting…",
  "cancel-prepare-vm": "Cancelling…",
  "verify-vm": "Verifying…",
  "open-vm-display": "Opening…",
  "release-vm": "Releasing…",
  "remove-vm": "Removing…",
} satisfies Record<Action, string>;

const VM_PROGRESS_POLL_MS = 2_000;

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
  const vm = vmOf(status);
  const preparing = vm?.state === "preparing";
  // Progress polling refreshes status constantly; that must not flicker the Cancel button.
  const busy = pending !== null || (driver.isPending && !preparing);
  const primary = vm === null ? primaryAction(status) : null;
  const telemetry =
    status?.status === "stopped" || status?.status === "running" ? status.telemetry : null;
  const [setupDesktopOpen, setSetupDesktopOpen] = useState(false);
  // Opening the setup desktop and viewing it need the same grant as the other VM controls.
  const canOperate = useAtomValue(computerUseEnvironment.control.permissionAtom(environmentId));
  const setupDesktopVisible =
    setupDesktopOpen &&
    environmentId !== null &&
    (vm?.state === "needs-consent" || (preparing && vm?.progress?.phase === "installing-driver"));
  useEffect(() => {
    if (!setupDesktopVisible) setSetupDesktopOpen(false);
  }, [setupDesktopVisible]);
  const [now, setNow] = useState(() => Date.now());
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
  // Preparation runs on the server whether or not this page is open, so follow it from status.
  // A cached status may be stale when the page is revisited, so read it once on mount too.
  const driverPending = useRef(driver.isPending);
  driverPending.current = driver.isPending;
  useEffect(() => {
    if (!driverPending.current) refreshDriver.current();
  }, []);
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      // Skip a tick rather than stack requests behind a slow one.
      if (!driverPending.current) refreshDriver.current();
    }, VM_PROGRESS_POLL_MS);
    return () => clearInterval(timer);
  }, [preparing]);

  /** Runs one control action; resolves with its failure message, or `null`. */
  const send = async (input: ComputerUseControlInput): Promise<string | null> => {
    if (environmentId === null) return "This environment isn't connected.";
    setPending(input.action);
    try {
      const result = await control({ environmentId, input });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
      const error = squashAtomCommandFailure(result);
      return isControlError(error) && error.detail.length > 0
        ? error.detail
        : error instanceof Error
          ? error.message
          : "The operation failed.";
    } finally {
      setPending(null);
      driver.refresh();
    }
  };
  const run = async (input: ComputerUseControlInput) => {
    // The setup desktop opens in Paperplane; the dialog starts the VM and shows its errors.
    if (input.action === "open-vm-display") {
      setSetupDesktopOpen(true);
      return;
    }
    const confirmation = vmConfirmation(input);
    if (confirmation !== null && !window.confirm(confirmation)) return;
    const failure = await send(input);
    if (failure !== null)
      toastManager.add({
        type: "error",
        title: controlFailureTitle(input.action),
        description: failure,
      });
  };

  return (
    <SettingsSection id="computer-use" title="Computer use">
      <SettingsRow
        {...searchableSetting("agent-computer-use")}
        serverScoped
        settingKeys={["enableAgentComputerUse"]}
        description="Use Cua Driver for background-only app control on Mac and Windows, or a private, offline Linux desktop per thread. Linux apps and files are temporary and cannot access the project or host desktop; watch them in the thread's Device panel. Turning this off discards Linux desktops and quits a Mac daemon Paperplane started."
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
          description="The isolated VM runs apps in a private macOS virtual machine, so agents never touch your desktop. Apple Silicon only. Needs about 150 GB of disk. Lume's password-protected VNC server may also be reachable on this Mac's network. Paperplane connects locally; use only on trusted networks."
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
                  disabled={
                    busy ||
                    environmentId === null ||
                    action.disabled === true ||
                    (action.input.action === "open-vm-display" && !canOperate)
                  }
                  onClick={() => void run(action.input)}
                >
                  {pending === action.input.action
                    ? PENDING_LABELS[action.input.action]
                    : action.label}
                </Button>
              ))}
              {isDiskBlocked(vm) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || environmentId === null}
                  onClick={driver.refresh}
                >
                  {driver.isPending ? "Checking…" : "Check again"}
                </Button>
              ) : null}
            </div>
          }
        >
          <VmSetupDetails vm={vm} now={now} />
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
          description="Cua collects a pseudonymous installation ID and content-free usage counts, never prompts, screen contents, or file paths. Paperplane turns this off when it installs Cua."
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
      {vm !== null && environmentId !== null ? (
        <VmSetupDesktopDialog
          open={setupDesktopVisible}
          environmentId={environmentId}
          setupCommand={vm.setupCommand}
          preparing={preparing}
          busy={busy}
          onOpenChange={setSetupDesktopOpen}
          onStart={() => send({ action: "open-vm-display" })}
          onVerify={() => {
            setSetupDesktopOpen(false);
            void run({ action: "verify-vm" });
          }}
        />
      ) : null}
    </SettingsSection>
  );
}

/** The VM's setup checklist, background progress, and the last preparation error. */
function VmSetupDetails({ vm, now }: { vm: ComputerUseMacosVm; now: number }) {
  const current = vmSetupStep(vm);
  if (current === null && vm.lastError === undefined) return null;
  const currentIndex = VM_SETUP_STEPS.findIndex((step) => step.id === current);
  const progress = vm.state === "preparing" ? describeVmProgress(vm.progress, now) : null;
  return (
    <div className="space-y-2 pt-1 pb-3">
      {current !== null ? (
        <ol className="space-y-1.5" aria-label="VM setup">
          {VM_SETUP_STEPS.map((step, index) => {
            const done = index < currentIndex;
            const active = index === currentIndex;
            return (
              <li
                key={step.id}
                aria-current={active ? "step" : undefined}
                className="flex min-w-0 gap-2 text-xs"
              >
                <span
                  aria-hidden
                  className={cn(
                    "grid size-4 shrink-0 place-items-center rounded-full text-2xs font-medium ring-1",
                    done
                      ? "bg-primary text-primary-foreground ring-primary"
                      : active
                        ? "bg-primary/10 text-primary ring-primary/30"
                        : "text-muted-foreground ring-border",
                  )}
                >
                  {done ? <CheckIcon className="size-3" /> : index + 1}
                </span>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex min-h-4 items-center justify-between gap-2">
                    <span
                      className={cn(
                        active ? "font-medium text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {step.label}
                      {done ? <span className="sr-only">, done</span> : null}
                    </span>
                  </div>
                  {active && progress !== null ? (
                    <div className="max-w-sm space-y-1.5">
                      <p role="status" className="tabular-nums text-muted-foreground">
                        {progress.text}
                      </p>
                      {progress.percent !== null ? (
                        <Progress label="VM preparation" value={progress.percent} />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
      {vm.lastError !== undefined ? (
        <p role="alert" className="text-xs break-words text-destructive-foreground">
          Last setup attempt failed: {vm.lastError}
        </p>
      ) : null}
    </div>
  );
}
