const disabledByBridge = new WeakMap<object, boolean>();

/**
 * True when the desktop app runs without its local server. The renderer then
 * has no primary environment: it skips primary auth and discovery and only
 * connects to saved remote environments. Always false in browsers and on
 * desktop builds predating the setting.
 *
 * Changing the setting relaunches the app, so a desktop answer is read over
 * synchronous IPC once per bridge and cached for the life of the page.
 */
export function isLocalEnvironmentDisabled(): boolean {
  const bridge = window.desktopBridge;
  if (bridge === undefined) return false;
  let disabled = disabledByBridge.get(bridge);
  if (disabled === undefined) {
    disabled = bridge.getLocalEnvironmentEnabled?.() === false;
    disabledByBridge.set(bridge, disabled);
  }
  return disabled;
}
