import type { EnvironmentId } from "@rove-code/contracts";
import { Monitor } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useComputerDesktops } from "~/state/computerUse";

import { type ComputerDesktopControls, ComputerDesktopView } from "../device/ComputerDesktopView";
import { DeviceLoadingView } from "../device/DeviceLoadingView";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { setupDesktopOf, singleLineShellCommand } from "./ComputerUseSettings.logic";

// The server registers the setup desktop before `open-vm-display` returns, so a
// missing one after this long means the subscription or the VM went away.
const SETUP_DESKTOP_WAIT_MS = 30_000;

type OpenState =
  | { readonly kind: "opening" }
  | { readonly kind: "open" }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * The VM's setup desktop inside Paperplane, for approving the permission prompts.
 * Opening asks the server to start the setup VM; the viewer then follows the
 * environment's desktop list like the Device panel does.
 */
export function VmSetupDesktopDialog({
  open,
  environmentId,
  setupCommand,
  preparing,
  busy,
  onOpenChange,
  onStart,
  onVerify,
}: {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly setupCommand: string | undefined;
  readonly preparing: boolean;
  readonly busy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Starts the setup VM; resolves with an error message, or `null` on success. */
  readonly onStart: () => Promise<string | null>;
  readonly onVerify: () => void;
}) {
  const [openState, setOpenState] = useState<OpenState>({ kind: "opening" });
  const [attempt, setAttempt] = useState(0);
  const [timedOut, setTimedOut] = useState(false);
  const [controls, setControls] = useState<ComputerDesktopControls | null>(null);
  const [typing, setTyping] = useState(false);
  const { state } = useComputerDesktops(open ? environmentId : null);
  const desktop = setupDesktopOf(state);

  // Starting the VM is a side effect of opening, so it runs once per open or retry.
  const startRef = useRef(onStart);
  startRef.current = onStart;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setOpenState({ kind: "opening" });
    setTimedOut(false);
    void startRef.current().then((error) => {
      if (cancelled) return;
      setOpenState(error === null ? { kind: "open" } : { kind: "failed", reason: error });
    });
    return () => {
      cancelled = true;
    };
  }, [attempt, open]);

  const waiting = open && openState.kind === "open" && desktop === null;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setTimedOut(true), SETUP_DESKTOP_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waiting]);

  const command = setupCommand === undefined ? null : singleLineShellCommand(setupCommand);
  const typeCommand = async () => {
    if (controls === null || command === null) return;
    setTyping(true);
    try {
      await controls.typeText(command);
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't type the command",
        description: cause instanceof Error ? cause.message : "The desktop disconnected.",
      });
    } finally {
      setTyping(false);
    }
  };

  const icon = <Monitor className="size-6 text-muted-foreground" />;
  const retry = () => setAttempt((value) => value + 1);
  const screen =
    openState.kind === "failed" || (waiting && timedOut) ? (
      <DeviceLoadingView
        name="macOS desktop setup"
        stage="opening"
        message={
          openState.kind === "failed"
            ? openState.reason
            : "The setup desktop didn't appear. Try again."
        }
        icon={icon}
        error
      >
        <Button size="sm" variant="outline" disabled={busy} onClick={retry}>
          Try again
        </Button>
      </DeviceLoadingView>
    ) : desktop === null ? (
      <DeviceLoadingView
        name="macOS desktop setup"
        stage="opening"
        message="Starting the setup desktop…"
        icon={icon}
      />
    ) : (
      <ComputerDesktopView
        environmentId={environmentId}
        desktopId={desktop.id}
        desktopKind={desktop.kind}
        name={desktop.name}
        visible={open}
        onControls={setControls}
      />
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>macOS desktop setup</DialogTitle>
          <DialogDescription>
            This is the VM, not your Mac. Click its screen to type into it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3 text-sm">
            <div className="h-[min(60vh,560px)] overflow-hidden rounded-xl border">{screen}</div>
            <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>Approve every Accessibility and Screen Recording prompt in the VM.</li>
              {command !== null ? (
                <li>
                  If no prompts appear, open Terminal in the VM, click its window, then select{" "}
                  <span className="font-medium text-foreground">Type setup command</span>. Press
                  Return in the VM to run it.
                </li>
              ) : null}
              <li>
                {preparing
                  ? "Setup is still running. Approve the prompts now; Verify becomes available when setup finishes."
                  : "Select Verify."}
              </li>
            </ol>
            {command !== null ? (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">Show command</summary>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-muted/50 p-3 font-mono">
                  {command}
                </pre>
              </details>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          {command !== null ? (
            <Button
              variant="outline"
              disabled={controls === null || typing}
              onClick={() => void typeCommand()}
            >
              {typing ? "Typing…" : "Type setup command"}
            </Button>
          ) : null}
          <Button disabled={busy || preparing} onClick={onVerify}>
            Verify
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
