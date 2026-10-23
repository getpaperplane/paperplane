import RFB from "@novnc/novnc";

import {
  desktopDisconnectOutcome,
  type DesktopStreamConfiguration,
} from "./desktop-stream-document";

declare global {
  interface Window {
    ReactNativeWebView: { postMessage: (message: string) => void };
  }
}

let activeRfb: RFB | null = null;

export function stop() {
  const rfb = activeRfb;
  activeRfb = null;
  rfb?.disconnect();
}

/**
 * Bundled into the native WebView, which speaks the device stream bridge:
 * status and unauthorized messages. Touch becomes mouse through noVNC's own
 * gesture handling; there is no on-screen keyboard yet.
 */
export function start(configuration: DesktopStreamConfiguration) {
  stop();
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- The native WebView bridge takes one string.
  const post = (message: object) => window.ReactNativeWebView.postMessage(JSON.stringify(message));
  const { colors, password, url } = configuration;
  Object.assign(document.documentElement.style, { height: "100%", overflow: "hidden" });
  Object.assign(document.body.style, {
    margin: "0",
    height: "100%",
    overflow: "hidden",
    background: colors.background,
  });
  const screen = document.createElement("div");
  Object.assign(screen.style, { position: "fixed", inset: "0", touchAction: "none" });
  document.body.replaceChildren(screen);

  const options: ConstructorParameters<typeof RFB>[2] = { wsProtocols: ["binary"] };
  if (password !== null) options.credentials = { password };
  const rfb = new RFB(screen, url, options);
  activeRfb = rfb;
  rfb.scaleViewport = true;
  rfb.focusOnClick = true;
  rfb.background = colors.background;
  let connected = false;
  let failed = false;
  const fail = (detail: string) => {
    failed = true;
    post({ type: "status", status: "error", detail });
  };
  post({ type: "status", status: "connecting" });
  rfb.addEventListener("connect", () => {
    connected = true;
    post({ type: "status", status: "streaming" });
  });
  rfb.addEventListener("credentialsrequired", () => {
    if (password !== null) rfb.sendCredentials({ password });
    else fail("The desktop asked for a password Paperplane doesn't have.");
  });
  rfb.addEventListener("securityfailure", () => fail("The desktop rejected Paperplane's credentials."));
  rfb.addEventListener("disconnect", () => {
    if (activeRfb !== rfb || failed) return;
    const outcome = desktopDisconnectOutcome({
      connected,
      hasTicket: configuration.hasTicket,
      ticketRefreshed: configuration.ticketRefreshed,
    });
    if (outcome === "refresh-ticket") post({ type: "unauthorized" });
    else {
      fail(
        outcome === "disconnected"
          ? "Disconnected from the desktop."
          : "The connection to the desktop was refused or closed.",
      );
    }
  });
}
