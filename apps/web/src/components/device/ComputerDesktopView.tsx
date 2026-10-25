import { computerDesktopViewerUrl } from "@getpaperplane/client-runtime/state/computer-use";
import { ComputerDesktopViewerError, type EnvironmentId } from "@getpaperplane/contracts";
import { squashAtomCommandFailure } from "@getpaperplane/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import type RFB from "@novnc/novnc";
import type { RfbOptions } from "@novnc/novnc";
import { Monitor } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { computerUseEnvironment } from "~/state/computerUse";
import { refreshDeviceHubAccess, useDeviceHubAccess } from "~/state/device";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { typingKeys } from "./computerDesktops.logic";
import { DeviceLoadingView } from "./DeviceLoadingView";

/** Input a parent may send to a connected desktop, beyond what the user does on the screen. */
export interface ComputerDesktopControls {
  /** Types one line of ASCII text into whatever has focus on the desktop, without pressing Return. */
  readonly typeText: (text: string) => Promise<void>;
}

const XK_SHIFT_L = 0xffe1;
// Burst size and pause between bursts, so the guest's input queue never drops keys.
const TYPING_BURST = 16;
const TYPING_PAUSE_MS = 12;
const VIEWER_RETRIES = 5;
const VIEWER_RETRY_MS = 2_000;
const isViewerError = Schema.is(ComputerDesktopViewerError);

type ViewerStatus =
  | { readonly kind: "connecting" }
  | { readonly kind: "connected" }
  | { readonly kind: "disconnected" }
  | { readonly kind: "error"; readonly reason: string };

/**
 * Loaded on first use: noVNC is large and uses top-level await, so it stays
 * out of the main bundle. Concurrent viewers share one import.
 */
let rfbModule: Promise<typeof RFB> | null = null;
const loadRfb = () => {
  rfbModule ??= import("@novnc/novnc").then(
    (module) => module.default,
    (cause: unknown) => {
      rfbModule = null;
      throw cause;
    },
  );
  return rfbModule;
};

/**
 * A computer-use private desktop over RFB. Like device streams, only a visible
 * surface connects; hiding or unmounting it closes the socket. Clicking the
 * screen focuses it so the keyboard reaches the desktop.
 */
export function ComputerDesktopView(props: {
  readonly environmentId: EnvironmentId;
  readonly desktopId: string;
  readonly desktopKind: "linux" | "macos-vm";
  readonly name: string;
  readonly visible: boolean;
  /** Floating previews have no room for a description line. */
  readonly compact?: boolean;
  /** Receives controls while the desktop is connected, and `null` otherwise. */
  readonly onControls?: (controls: ComputerDesktopControls | null) => void;
}) {
  const onControlsRef = useRef(props.onControls);
  onControlsRef.current = props.onControls;
  const access = useDeviceHubAccess(props.environmentId);
  const viewer = useAtomCommand(computerUseEnvironment.viewer, { reportFailure: false });
  const screenRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<ViewerStatus>({ kind: "connecting" });
  const [attempt, setAttempt] = useState(0);
  // One silent ticket refresh per failure streak; a desktop that keeps refusing shows its error.
  const ticketRefreshedRef = useRef(false);

  useEffect(() => {
    const screen = screenRef.current;
    if (!screen || !access || !props.visible) return;
    let cancelled = false;
    let rfb: RFB | null = null;
    let connected = false;
    setStatus({ kind: "connecting" });
    void (async () => {
      // Credentials are minted per connect; the desktop stream never carries them.
      // A VM that just booted has no display address for a few seconds, so
      // early refusals are retried a bounded number of times before showing.
      let result = await viewer({
        environmentId: props.environmentId,
        input: { desktopId: props.desktopId },
      });
      for (
        let retry = 0;
        result._tag === "Failure" &&
        isViewerError(squashAtomCommandFailure(result)) &&
        retry < VIEWER_RETRIES;
        retry++
      ) {
        await new Promise((resolve) => setTimeout(resolve, VIEWER_RETRY_MS));
        if (cancelled) return;
        result = await viewer({
          environmentId: props.environmentId,
          input: { desktopId: props.desktopId },
        });
      }
      if (cancelled) return;
      if (result._tag === "Failure") {
        setStatus({ kind: "error", reason: formatEnvironmentQueryError(result.cause) });
        return;
      }
      let Rfb: typeof RFB;
      try {
        Rfb = await loadRfb();
      } catch {
        if (!cancelled)
          setStatus({
            kind: "error",
            reason: "The desktop viewer failed to load. Reload Paperplane.",
          });
        return;
      }
      if (cancelled) return;
      const { path, password } = result.value;
      const options: RfbOptions = { wsProtocols: ["binary"] };
      if (password !== null) options.credentials = { password };
      rfb = new Rfb(screen, computerDesktopViewerUrl(access, path), options);
      rfb.scaleViewport = true;
      rfb.focusOnClick = true;
      rfb.background = "transparent";
      rfb.addEventListener("connect", () => {
        connected = true;
        ticketRefreshedRef.current = false;
        setStatus({ kind: "connected" });
        onControlsRef.current?.({
          typeText: async (text) => {
            const keys = typingKeys(text);
            if (keys === null) throw new Error("Only single-line ASCII text can be typed.");
            for (const [index, key] of keys.entries()) {
              if (cancelled || rfb === null) return;
              if (index > 0 && index % TYPING_BURST === 0)
                await new Promise((resolve) => setTimeout(resolve, TYPING_PAUSE_MS));
              if (cancelled || rfb === null) return;
              if (key.shift) rfb.sendKey(XK_SHIFT_L, "ShiftLeft", true);
              rfb.sendKey(key.keysym, "");
              if (key.shift) rfb.sendKey(XK_SHIFT_L, "ShiftLeft", false);
            }
          },
        });
      });
      rfb.addEventListener("credentialsrequired", () => {
        if (password !== null) rfb?.sendCredentials({ password });
        else
          setStatus({
            kind: "error",
            reason: "The desktop asked for a password Paperplane doesn't have.",
          });
      });
      rfb.addEventListener("securityfailure", () => {
        setStatus({ kind: "error", reason: "The desktop rejected Paperplane's credentials." });
      });
      rfb.addEventListener("disconnect", () => {
        rfb = null;
        onControlsRef.current?.(null);
        if (cancelled) return;
        // A socket that never connected is most often an expired ticket; the
        // fresh ticket re-runs this effect. Only once, so a refusal can't loop.
        if (!connected && access.query.wsTicket && !ticketRefreshedRef.current) {
          ticketRefreshedRef.current = true;
          refreshDeviceHubAccess(props.environmentId);
          return;
        }
        setStatus((current) =>
          current.kind === "error"
            ? current
            : connected
              ? { kind: "disconnected" }
              : {
                  kind: "error",
                  reason: "The connection to the desktop was refused or closed.",
                },
        );
      });
    })();
    return () => {
      cancelled = true;
      if (connected) onControlsRef.current?.(null);
      rfb?.disconnect();
      rfb = null;
    };
  }, [access, attempt, props.desktopId, props.environmentId, props.visible, viewer]);

  const retry = () => {
    ticketRefreshedRef.current = false;
    setAttempt((value) => value + 1);
  };
  const description = props.compact
    ? undefined
    : props.desktopKind === "linux"
      ? "Private Linux desktop"
      : "Isolated macOS VM";
  const icon = <Monitor className="size-6 text-muted-foreground" />;
  const overlay =
    status.kind === "connecting" ? (
      <DeviceLoadingView
        name={props.name}
        {...(description ? { description } : {})}
        stage="stream"
        message="Connecting to desktop…"
        icon={icon}
      />
    ) : status.kind === "disconnected" ? (
      <DeviceLoadingView
        name={props.name}
        {...(description ? { description } : {})}
        stage="stream"
        message="Disconnected from the desktop."
        icon={icon}
        error
      >
        <Button size="sm" variant="outline" onClick={retry}>
          Reconnect
        </Button>
      </DeviceLoadingView>
    ) : status.kind === "error" ? (
      <DeviceLoadingView
        name={props.name}
        {...(description ? { description } : {})}
        stage="stream"
        message={status.reason}
        icon={icon}
        error
      >
        <Button size="sm" variant="outline" onClick={retry}>
          Try again
        </Button>
      </DeviceLoadingView>
    ) : null;

  return (
    <div className="relative size-full min-h-0 min-w-0 bg-background">
      {/* noVNC owns this element's children; React never renders into it. */}
      <div
        ref={screenRef}
        data-computer-desktop-screen
        aria-label={`${props.name} screen`}
        className="size-full overflow-hidden"
        hidden={status.kind !== "connected"}
      />
      {overlay ? <div className="absolute inset-0">{overlay}</div> : null}
    </div>
  );
}
