import { scopedThreadKey } from "@getpaperplane/client-runtime/environment";
import type { DevicePlatform, ScopedThreadRef } from "@getpaperplane/contracts";
import { create } from "zustand";

import type { DeviceTabTarget } from "./rightPanelStore";

export interface PreviewMiniPlayerPosition {
  readonly x: number;
  readonly y: number;
}

export interface PreviewMiniPlayerSize {
  readonly width: number;
  readonly height: number;
}

/** What the floating player mirrors: a browser tab, a device stream, or a computer desktop. */
export type PreviewMiniPlayerSource =
  | { readonly kind: "browser"; readonly tabId: string }
  | {
      readonly kind: "device";
      readonly hostId: string;
      readonly deviceId: string;
      readonly platform: DevicePlatform;
      readonly name: string;
    }
  | {
      readonly kind: "computer";
      readonly desktopId: string;
      readonly desktopKind: "linux" | "macos-vm";
      readonly name: string;
    };

export interface PreviewMiniPlayerState {
  readonly source: PreviewMiniPlayerSource;
  readonly position: PreviewMiniPlayerPosition | null;
  /** Height always follows the mirrored source's aspect ratio. */
  readonly width: number | null;
  readonly lastInteraction: "drag" | "resize";
}

interface PreviewMiniPlayerStoreState {
  readonly byThreadKey: Record<string, PreviewMiniPlayerState>;
  readonly open: (ref: ScopedThreadRef, source: PreviewMiniPlayerSource) => void;
  readonly close: (ref: ScopedThreadRef) => void;
  /** `sourceKey` guards against a drag that outlives the source it started on. */
  readonly move: (
    ref: ScopedThreadRef,
    sourceKey: string,
    position: PreviewMiniPlayerPosition,
  ) => void;
  readonly resize: (
    ref: ScopedThreadRef,
    sourceKey: string,
    width: number,
    position?: PreviewMiniPlayerPosition,
  ) => void;
  readonly removeThread: (ref: ScopedThreadRef) => void;
}

export function previewMiniPlayerSourceKey(source: PreviewMiniPlayerSource): string {
  switch (source.kind) {
    case "browser":
      return `browser:${source.tabId}`;
    case "device":
      return `device:${encodeURIComponent(source.hostId)}:${encodeURIComponent(source.deviceId)}`;
    case "computer":
      return `computer:${encodeURIComponent(source.desktopId)}`;
  }
}

/** Floats the simulator or desktop a Device panel tab shows. */
export function deviceMiniPlayerSource(target: DeviceTabTarget): PreviewMiniPlayerSource {
  return target.kind === "computer"
    ? {
        kind: "computer",
        desktopId: target.desktopId,
        desktopKind: target.desktopKind,
        name: target.name,
      }
    : {
        kind: "device",
        hostId: target.hostId,
        deviceId: target.deviceId,
        platform: target.platform,
        name: target.name,
      };
}

/** The Device panel tab target for a floating device or desktop. */
export function deviceTabTargetOfMiniPlayerSource(
  source: Exclude<PreviewMiniPlayerSource, { kind: "browser" }>,
): DeviceTabTarget {
  return source.kind === "computer"
    ? {
        kind: "computer",
        desktopId: source.desktopId,
        desktopKind: source.desktopKind,
        name: source.name,
      }
    : {
        hostId: source.hostId,
        deviceId: source.deviceId,
        platform: source.platform,
        name: source.name,
      };
}

export const browserMiniPlayerSource = (tabId: string): PreviewMiniPlayerSource => ({
  kind: "browser",
  tabId,
});

export const usePreviewMiniPlayerStore = create<PreviewMiniPlayerStoreState>()((set) => ({
  byThreadKey: {},
  open: (ref, source) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      if (
        current &&
        previewMiniPlayerSourceKey(current.source) === previewMiniPlayerSourceKey(source)
      ) {
        return state;
      }
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: {
            source,
            position: current?.position ?? null,
            width: current?.width ?? null,
            lastInteraction: current?.lastInteraction ?? "drag",
          },
        },
      };
    }),
  close: (ref) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      if (!(threadKey in state.byThreadKey)) return state;
      const { [threadKey]: _closed, ...byThreadKey } = state.byThreadKey;
      return { byThreadKey };
    }),
  move: (ref, sourceKey, position) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      if (!current || previewMiniPlayerSourceKey(current.source) !== sourceKey) return state;
      if (
        current.position?.x === position.x &&
        current.position.y === position.y &&
        current.lastInteraction === "drag"
      )
        return state;
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: { ...current, position, lastInteraction: "drag" },
        },
      };
    }),
  resize: (ref, sourceKey, width, position) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      if (
        !current ||
        previewMiniPlayerSourceKey(current.source) !== sourceKey ||
        (current.width === width &&
          current.lastInteraction === "resize" &&
          (!position || (current.position?.x === position.x && current.position.y === position.y)))
      ) {
        return state;
      }
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: {
            ...current,
            width,
            position: position ?? current.position,
            lastInteraction: "resize",
          },
        },
      };
    }),
  removeThread: (ref) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      if (!(threadKey in state.byThreadKey)) return state;
      const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
      return { byThreadKey };
    }),
}));

export function selectThreadPreviewMiniPlayer(
  byThreadKey: Record<string, PreviewMiniPlayerState>,
  ref: ScopedThreadRef | null | undefined,
): PreviewMiniPlayerState | null {
  if (!ref) return null;
  return byThreadKey[scopedThreadKey(ref)] ?? null;
}

/** The floating browser tab, or null when nothing floats or a device does. */
export function selectThreadPreviewMiniPlayerTabId(
  byThreadKey: Record<string, PreviewMiniPlayerState>,
  ref: ScopedThreadRef | null | undefined,
): string | null {
  const source = selectThreadPreviewMiniPlayer(byThreadKey, ref)?.source;
  return source?.kind === "browser" ? source.tabId : null;
}
