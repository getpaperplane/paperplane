export interface DesktopStreamConfiguration {
  /** Authenticated RFB WebSocket URL, including the wsTicket. */
  readonly url: string;
  /** VNC password minted for this connect, or null when the desktop has none. */
  readonly password: string | null;
  /** The first failure to connect may be an expired ticket; the app refreshes it once. */
  readonly ticketRefreshed: boolean;
  readonly hasTicket: boolean;
  readonly colors: { readonly background: string; readonly foreground: string };
}

/** One failure streak gets one silent ticket refresh; after that the user sees the error. */
export function desktopDisconnectOutcome(input: {
  readonly connected: boolean;
  readonly hasTicket: boolean;
  readonly ticketRefreshed: boolean;
}): "refresh-ticket" | "disconnected" | "refused" {
  if (input.connected) return "disconnected";
  return input.hasTicket && !input.ticketRefreshed ? "refresh-ticket" : "refused";
}
