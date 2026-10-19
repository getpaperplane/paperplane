// noVNC ships untyped ESM. Only the RFB surface the computer desktop viewer uses is declared.
declare module "@novnc/novnc" {
  export interface RfbOptions {
    credentials?: { readonly password?: string };
    shared?: boolean;
    wsProtocols?: ReadonlyArray<string>;
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: RfbOptions);
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    focusOnClick: boolean;
    viewOnly: boolean;
    background: string;
    disconnect(): void;
    sendCredentials(credentials: { readonly password?: string }): void;
    focus(options?: FocusOptions): void;
    /** Presses and releases `keysym` when `down` is omitted. */
    sendKey(keysym: number, code: string, down?: boolean): void;
  }
}
