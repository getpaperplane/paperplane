import type { EnvironmentConnectionPhase } from "@rove-code/client-runtime/connection";

/**
 * What the floating pill says. Connection, syncing, and working share one
 * element so the label swaps in place instead of one pill fading out for
 * another. The connection variant is tappable and triggers a reconnect.
 */
export type FloatingWorkingStatus =
  | { readonly kind: "working"; readonly startedAt: string }
  | { readonly kind: "syncing"; readonly label: string }
  | { readonly kind: "compacting" }
  | { readonly kind: "background"; readonly label: string; readonly onPress: () => void }
  // A task whose thread the server has not created yet: the worktree may
  // still be checking out, so there is no turn to time.
  | { readonly kind: "preparing"; readonly label: string }
  | {
      readonly kind: "connection";
      readonly tone: "reconnecting" | "unavailable";
      readonly label: string;
      readonly onPress: () => void;
    };

/** Background work is independent of the parent response and has its own Stop affordance. */
export function backgroundFloatingStatus(input: {
  readonly parentActive: boolean;
  readonly liveness: "working" | "monitoring" | null | undefined;
  readonly onStop: () => void;
}): FloatingWorkingStatus | null {
  if (input.parentActive || input.liveness == null) return null;
  return {
    kind: "background",
    label: input.liveness === "working" ? "Background agents · Stop" : "Monitoring · Stop",
    onPress: input.onStop,
  };
}

/**
 * The pill's connection variant, or null once the environment is connected and
 * the pill is free to report sync and working state instead.
 */
export function connectionFloatingStatus(input: {
  readonly connectionError: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly environmentLabel: string | null;
  readonly onReconnect: () => void;
}): FloatingWorkingStatus | null {
  const environmentLabel = input.environmentLabel ?? "Environment";
  const unavailable = (label: string): FloatingWorkingStatus => ({
    kind: "connection",
    tone: "unavailable",
    label,
    onPress: input.onReconnect,
  });

  switch (input.connectionState) {
    case "connecting":
    case "reconnecting":
      return {
        kind: "connection",
        tone: "reconnecting",
        label:
          input.connectionError === null
            ? `Reconnecting to ${environmentLabel}...`
            : `Failed to connect. Retrying ${environmentLabel}...`,
        onPress: input.onReconnect,
      };
    case "offline":
      return unavailable("You are offline");
    case "unsupported":
      return unavailable("Client not supported");
    case "error":
      return unavailable(
        input.connectionError
          ? `Failed to connect to ${environmentLabel}: ${input.connectionError}`
          : `Failed to connect to ${environmentLabel}`,
      );
    case "available":
      return unavailable(`${environmentLabel} is not connected`);
    case "connected":
      return null;
  }
}
