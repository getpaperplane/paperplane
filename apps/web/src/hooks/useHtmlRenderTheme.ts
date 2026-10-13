import {
  chartVariables,
  HTML_RENDER_THEME_VARIABLES,
  type HtmlRenderTheme,
} from "@rove-code/shared/htmlRender";
import { useSyncExternalStore } from "react";

/**
 * The app's active theme as HTML render variables. Themes apply by changing
 * the root element's class, style, and data attributes, so one observer on it
 * serves every mounted page; a snapshot keeps its identity until a value
 * actually changes.
 */
let snapshot: HtmlRenderTheme | null = null;
let snapshotKey = "";
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function readTheme(): HtmlRenderTheme {
  const root = document.documentElement;
  const appearance = root.classList.contains("dark") ? "dark" : "light";
  const style = getComputedStyle(root);
  const variables: Record<string, string> = { ...chartVariables(appearance) };
  for (const name of HTML_RENDER_THEME_VARIABLES) {
    const value = style.getPropertyValue(name).trim();
    if (value) variables[name] = value;
  }
  return { appearance, variables };
}

function refresh() {
  const next = readTheme();
  const key = JSON.stringify(next);
  if (key === snapshotKey) return false;
  snapshot = next;
  snapshotKey = key;
  return true;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!observer) {
    observer = new MutationObserver(() => {
      if (refresh()) for (const notify of listeners) notify();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme-id"],
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
    }
  };
}

function getSnapshot(): HtmlRenderTheme {
  if (snapshot === null || !observer) refresh();
  return snapshot!;
}

export function useHtmlRenderTheme(): HtmlRenderTheme {
  return useSyncExternalStore(subscribe, getSnapshot);
}
