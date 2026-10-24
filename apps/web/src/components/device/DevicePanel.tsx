import { DeviceHostUpdates } from "./DeviceHostUpdates";
import type {
  DevicePlatform,
  DeviceServiceState,
  DeviceSummary,
  ScopedThreadRef,
} from "@getpaperplane/contracts";
import { Link } from "@tanstack/react-router";
import { threadComputerDesktops } from "@getpaperplane/client-runtime/state/computer-use";
import { Monitor, Smartphone, X } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";

import { deviceMiniPlayerSource, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import {
  type ComputerTabTarget,
  useRightPanelStore,
  type RightPanelSurface,
} from "~/rightPanelStore";
import { Button } from "~/components/ui/button";
import { DiscoveryList, DiscoveryListRow } from "~/components/ui/discovery-list";
import { Dialog } from "~/components/ui/dialog";
import { WizardPopup } from "~/components/ui/wizard";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { computerUseEnvironment, useComputerDesktops } from "~/state/computerUse";
import { deviceEnvironment, useDeviceState } from "~/state/device";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { ComputerDesktopView } from "./ComputerDesktopView";
import { computerPickerNote, computerTabTarget } from "./computerDesktops.logic";
import { DeviceLoadingView } from "./DeviceLoadingView";
import { DeviceSetup, deviceHubReadiness } from "./DeviceSetup";
import { DeviceWorkspace } from "./DeviceWorkspace";
import { PreviewPanelShell, type PreviewPanelMode } from "../preview/PreviewPanelShell";

const platformLabel = (platform: DevicePlatform) =>
  platform === "ios" ? "iOS Simulators" : "Android Emulators";

const deviceKey = (device: Pick<DeviceSummary, "hostId" | "id">) =>
  `${device.hostId}\u0000${device.id}`;

type DevicePanelProps = {
  readonly mode: PreviewPanelMode;
  readonly threadRef: ScopedThreadRef;
  readonly surface: Extract<RightPanelSurface, { kind: "device" }>;
  readonly visible: boolean;
  readonly onDismissSetup: () => void;
};

/** Each surface owns one host/device or computer desktop; only the visible surface streams. */
export function DevicePanel(props: DevicePanelProps) {
  const target = props.surface.target;
  return target?.kind === "computer" ? (
    <ComputerDesktopSurface {...props} target={target} />
  ) : (
    <SimulatorPanel {...props} />
  );
}

/**
 * A desktop tab. It renders while the desktop is listed; once the stream drops
 * it, ChatView closes the tab, so there is no "missing desktop" state here.
 */
function ComputerDesktopSurface(props: DevicePanelProps & { readonly target: ComputerTabTarget }) {
  const { environmentId } = props.threadRef;
  const canView = useAtomValue(computerUseEnvironment.viewer.permissionAtom(environmentId));
  const floatDesktop = () => {
    usePreviewMiniPlayerStore
      .getState()
      .open(props.threadRef, deviceMiniPlayerSource(props.target));
    useRightPanelStore.getState().close(props.threadRef);
  };
  return (
    <PreviewPanelShell mode={props.mode}>
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
        <Monitor className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {props.target.desktopKind === "linux"
            ? "Private Linux desktop. Click the screen to type."
            : "Isolated macOS VM. Click the screen to type."}
        </span>
        <Button size="xs" variant="ghost" onClick={floatDesktop}>
          Float over chat
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1">
        {canView ? (
          <ComputerDesktopView
            environmentId={environmentId}
            desktopId={props.target.desktopId}
            desktopKind={props.target.desktopKind}
            name={props.surface.title ?? props.target.name}
            visible={props.visible}
          />
        ) : (
          <p className="p-3 text-xs text-muted-foreground">Needs operate access to view</p>
        )}
      </div>
    </PreviewPanelShell>
  );
}

function SimulatorPanel(props: DevicePanelProps) {
  const { environmentId, threadId } = props.threadRef;
  const canView = useAtomValue(computerUseEnvironment.viewer.permissionAtom(environmentId));
  const { state, loaded } = useDeviceState(environmentId);
  const { state: computerState } = useComputerDesktops(environmentId);
  const computerUseEnabled = useEnvironmentSettings(
    environmentId,
    (settings) => settings.enableAgentComputerUse,
  );
  const desktops = useMemo(
    () => threadComputerDesktops(computerState, threadId),
    [computerState, threadId],
  );
  const computerNote = computerPickerNote({
    mode: computerState.mode,
    enabled: computerUseEnabled,
    desktopCount: desktops.length,
  });
  // Desktops don't need the device hub, so a Linux host with no simulators can still watch them.
  const [simulatorSetupOpen, setSimulatorSetupOpen] = useState(false);
  const list = useAtomCommand(deviceEnvironment.list, { reportFailure: false });
  const open = useAtomCommand(deviceEnvironment.open);
  const close = useAtomCommand(deviceEnvironment.close);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [pendingDevice, setPendingDevice] = useState<DeviceSummary | null>(null);
  const pendingDeviceKey = pendingDevice ? deviceKey(pendingDevice) : null;

  const hostDisabled = state.hostStatus === "disabled";
  const hubNeedsSetup = loaded && (!state.onboardingCompleted || hostDisabled);

  // Opening setup never grants permission to install or start helpers.
  useEffect(() => {
    if (!props.visible || !loaded || hostDisabled) return;
    void list({ environmentId, input: {} });
  }, [environmentId, list, loaded, props.visible, hostDisabled]);

  const sessions = useMemo(
    () => state.sessions.filter((session) => session.threadId === threadId),
    [state.sessions, threadId],
  );
  const target = props.surface.target?.kind === "computer" ? undefined : props.surface.target;
  const activeSession = target
    ? sessions.find(
        (session) => session.deviceId === target.deviceId && session.hostId === target.hostId,
      )
    : undefined;
  const activeDevice = activeSession
    ? state.devices.find(
        (device) => device.hostId === activeSession.hostId && device.id === activeSession.deviceId,
      )
    : undefined;

  const grouped = useMemo(() => groupDevices(state), [state]);

  const openDesktop = (desktop: (typeof desktops)[number]) =>
    useRightPanelStore.getState().openDevice(props.threadRef, computerTabTarget(desktop));

  const selectDevice = async (value: string) => {
    const device = state.devices.find((candidate) => deviceKey(candidate) === value);
    if (!device) return;
    setOperationError(null);
    setPendingDevice(device);
    try {
      const result = await open({
        environmentId,
        input: {
          threadId,
          hostId: device.hostId,
          deviceId: device.id,
          platform: device.platform,
        },
      });
      if (result._tag === "Failure") setOperationError(formatEnvironmentQueryError(result.cause));
      else
        useRightPanelStore.getState().openDevice(props.threadRef, {
          hostId: result.value.hostId,
          deviceId: result.value.deviceId,
          platform: device.platform,
          name: device.name,
        });
    } finally {
      setPendingDevice(null);
    }
  };

  // Floating the device closes the panel, like the browser's floating preview.
  const floatActive = () => {
    if (!activeDevice) return;
    usePreviewMiniPlayerStore.getState().open(
      props.threadRef,
      deviceMiniPlayerSource({
        hostId: activeDevice.hostId,
        deviceId: activeDevice.id,
        platform: activeDevice.platform,
        name: activeDevice.name,
      }),
    );
    useRightPanelStore.getState().close(props.threadRef);
  };

  const closeActive = (powerOff: boolean) => {
    if (!powerOff) {
      useRightPanelStore.getState().closeSurface(props.threadRef, props.surface.id);
      return;
    }
    if (!activeSession) return;
    setOperationError(null);
    void close({
      environmentId,
      input: {
        threadId,
        hostId: activeSession.hostId,
        deviceId: activeSession.deviceId,
        shutdown: powerOff,
      },
    }).then((result) => {
      if (result._tag === "Failure") setOperationError(formatEnvironmentQueryError(result.cause));
      else useRightPanelStore.getState().closeSurface(props.threadRef, props.surface.id);
    });
  };

  const bootingDevices =
    state.bootingDevices?.filter((device) => device.threadId === threadId) ?? [];
  const { ready: hostReady, busy: hostBusy } = deviceHubReadiness(state);
  const unavailablePlatforms = state.hosts.flatMap((host) =>
    host.platforms
      .filter((platform) => !platform.available)
      .map((platform) => ({ ...platform, hostId: host.id, hostLabel: host.label })),
  );

  const computersSection =
    desktops.length > 0 || computerNote !== null ? (
      <section className="w-full space-y-3 text-left">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Monitor className="size-4 shrink-0" />
          <h3 className="font-medium">Computers</h3>
        </div>
        {desktops.length > 0 && !canView ? (
          <p className="text-xs text-muted-foreground">Needs operate access to view</p>
        ) : desktops.length > 0 ? (
          <DiscoveryList>
            {desktops.map((desktop) => (
              <DiscoveryListRow
                key={desktop.id}
                icon={
                  <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/60">
                    <Monitor className="size-4" />
                  </span>
                }
                title={desktop.name}
                description={`${desktop.kind === "linux" ? "Private Linux desktop" : "Isolated macOS VM"} · ${desktop.role === "setup" ? "Setup" : "This thread"}`}
                aria-label={`Open ${desktop.name}`}
                onClick={() => openDesktop(desktop)}
                action={<span className="text-xs text-muted-foreground">Open</span>}
              />
            ))}
          </DiscoveryList>
        ) : computerNote === "host" ? (
          <p className="text-xs">
            Computer use acts on this Mac's apps in the background, so there's no separate desktop
            to show.{" "}
            <Link
              to="/settings/integrations"
              hash="computer-use"
              className="underline underline-offset-4 hover:text-foreground"
            >
              Computer use settings
            </Link>
          </p>
        ) : (
          <p className="text-xs">
            A desktop appears here once an agent uses computer use in this thread.
          </p>
        )}
      </section>
    ) : null;

  if (hubNeedsSetup && desktops.length === 0) {
    return (
      <Dialog
        open={props.visible}
        onOpenChange={(isOpen) => {
          if (!isOpen) props.onDismissSetup();
        }}
      >
        <WizardPopup>
          <DeviceSetup environmentId={environmentId} state={state} />
        </WizardPopup>
      </Dialog>
    );
  }

  if (hubNeedsSetup) {
    return (
      <PreviewPanelShell mode={props.mode}>
        <div className="scrollbar-gutter-both flex size-full flex-col overflow-y-auto px-5 py-8 text-sm text-muted-foreground">
          <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
            {computersSection}
            <Button
              className="self-start"
              variant="ghost"
              size="sm"
              onClick={() => setSimulatorSetupOpen(true)}
            >
              <Smartphone />
              Set up simulators
            </Button>
          </div>
        </div>
        <Dialog open={props.visible && simulatorSetupOpen} onOpenChange={setSimulatorSetupOpen}>
          <WizardPopup>
            <DeviceSetup
              environmentId={environmentId}
              state={state}
              onComplete={() => setSimulatorSetupOpen(false)}
            />
          </WizardPopup>
        </Dialog>
      </PreviewPanelShell>
    );
  }

  return (
    <PreviewPanelShell mode={props.mode}>
      {hostReady && !activeDevice && state.hostStatusDetail ? (
        <div
          role="status"
          className="whitespace-pre-line border-b px-3 py-2 text-xs text-muted-foreground"
        >
          {state.hostStatusDetail}
        </div>
      ) : null}
      <DeviceHostUpdates state={state} environmentId={environmentId} />
      {bootingDevices.length > 0 ? (
        <div role="status" className="border-b px-3 py-2 text-xs text-muted-foreground">
          Starting {bootingDevices.map((device) => device.name).join(", ")}… This can take a minute.
        </div>
      ) : null}
      {operationError ? (
        <div
          role="alert"
          className="flex items-start gap-2 border-b bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{operationError}</p>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss device error"
            onClick={() => setOperationError(null)}
          >
            <X className="size-3" />
          </Button>
        </div>
      ) : null}
      <div className="@container relative flex min-h-0 flex-1">
        {activeDevice && activeSession ? (
          <DeviceWorkspace
            key={`${environmentId}\u0000${deviceKey(activeDevice)}`}
            environmentId={environmentId}
            device={activeDevice}
            hostLabel={
              state.hosts.find((host) => host.id === activeDevice.hostId)?.label ?? "Device host"
            }
            hostDiagnostics={state.hostStatusDetail}
            visible={props.visible}
            onFloat={floatActive}
            onClose={() => closeActive(false)}
            onPowerOff={() => closeActive(true)}
          />
        ) : pendingDevice || hostBusy || !loaded ? (
          <DeviceLoadingView
            name={pendingDevice?.name ?? "Devices"}
            description={
              pendingDevice
                ? `${state.hosts.find((host) => host.id === pendingDevice.hostId)?.label ?? "Device host"} · ${pendingDevice.version}`
                : ""
            }
            stage="opening"
            message={
              pendingDevice
                ? pendingDevice.booted
                  ? "Opening device…"
                  : "Starting device…"
                : state.hostStatus === "installing"
                  ? (state.hostStatusDetail ?? "Installing device support…")
                  : "Finding devices…"
            }
          />
        ) : (
          <div className="scrollbar-gutter-both flex size-full flex-col overflow-y-auto px-5 py-8 text-sm text-muted-foreground">
            <div
              className={cn(
                "mx-auto flex w-full max-w-xl flex-col gap-6",
                grouped.length === 0 && !computersSection && "my-auto items-center text-center",
              )}
            >
              {computersSection}
              {grouped.length === 0 ? (
                <>
                  {computersSection ? null : <Smartphone className="size-6 opacity-60" />}
                  <p className={computersSection ? "text-xs" : "max-w-sm"}>
                    {state.hostStatus === "failed"
                      ? (state.hostStatusDetail ?? "The device hub failed to start.")
                      : "No simulators or emulators were found on this environment."}
                  </p>
                </>
              ) : null}
              {hostReady && grouped.length > 0 ? (
                <div className="w-full space-y-6 text-left">
                  {grouped.map((group) => (
                    <section key={group.platform} className="space-y-3">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Smartphone className="size-4 shrink-0" />
                        <h3 className="font-medium">{platformLabel(group.platform)}</h3>
                      </div>
                      <DiscoveryList>
                        {group.devices.map((device) => (
                          <DiscoveryListRow
                            key={deviceKey(device)}
                            icon={
                              <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/60">
                                <Smartphone className="size-4" />
                              </span>
                            }
                            title={device.name}
                            description={`${state.hosts.find((host) => host.id === device.hostId)?.label} · ${device.version} · ${device.booted ? "Running" : "Stopped"}`}
                            disabled={pendingDeviceKey !== null}
                            aria-label={`${device.booted ? "Open" : "Start"} ${device.name}`}
                            onClick={() => void selectDevice(deviceKey(device))}
                            action={
                              pendingDeviceKey === deviceKey(device) ? (
                                <Spinner size="xs" />
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  {device.booted ? "Open" : "Start"}
                                </span>
                              )
                            }
                          />
                        ))}
                      </DiscoveryList>
                    </section>
                  ))}
                </div>
              ) : null}
              {hostReady &&
              !state.devices.some((device) => device.platform === "android") &&
              !unavailablePlatforms.some((platform) => platform.platform === "android") ? (
                <p className="max-w-sm text-xs">
                  No Android virtual devices found. Create one in Android Studio's Device Manager,
                  then refresh.
                </p>
              ) : null}
              {loaded && !hostBusy ? (
                <Button
                  className={grouped.length > 0 || computersSection ? "self-start" : "self-center"}
                  variant={grouped.length > 0 || computersSection ? "ghost" : "outline"}
                  size="sm"
                  onClick={() => void list({ environmentId, input: {} })}
                >
                  Refresh devices
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </PreviewPanelShell>
  );
}

function groupDevices(state: DeviceServiceState) {
  const groups: Array<{ platform: DevicePlatform; devices: DeviceSummary[] }> = [];
  for (const platform of ["ios", "android"] as const) {
    const devices = state.devices
      .filter((device) => device.platform === platform)
      .toSorted((a, b) => Number(b.booted) - Number(a.booted) || a.name.localeCompare(b.name));
    if (devices.length > 0) groups.push({ platform, devices });
  }
  return groups;
}
