import { computerDesktopViewerUrl } from "@getpaperplane/client-runtime/state/computer-use";
import desktopStreamScript from "@getpaperplane/mobile-desktop-stream";
import type { EnvironmentId } from "@getpaperplane/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText } from "../../components/ui/AppText";
import { computerUseEnvironment } from "../../state/computer-use";
import { refreshDeviceHubAccess, useDeviceHubAccess } from "../../state/device";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { DesktopStreamConfiguration } from "./desktop-stream-document";
import { isViewerRetryable } from "./desktop-viewer-retry";
import { StreamWebView } from "./DeviceStreamWebView";
import type { ThreadDesktopPreview } from "./threadDevicePreviews";

const noInput = async () => {};
const VIEWER_RETRIES = 5;
const VIEWER_RETRY_MS = 2_000;

/**
 * A computer-use private desktop over RFB in a WebView. Viewer credentials are
 * fetched fresh per connect; closing the viewer only stops watching.
 */
export function DesktopStreamView({
  environmentId,
  preview,
}: {
  readonly environmentId: EnvironmentId;
  readonly preview: ThreadDesktopPreview;
}) {
  const { desktop } = preview;
  const { themeVariables } = useAppearancePreferences();
  const { access, error: accessError } = useDeviceHubAccess(environmentId);
  const viewer = useAtomCommand(computerUseEnvironment.viewer, { reportFailure: false });
  const [configuration, setConfiguration] = useState<string | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const ticketRefreshed = useRef(false);
  const background = themeVariables["--color-sheet-solid"];
  const foreground = themeVariables["--color-foreground"];
  // Colours are sampled when a connection is configured. Keeping them out of the
  // connect effect means a light/dark switch recolours the surround without
  // minting credentials or reconnecting the desktop.
  const colors = useRef({ background, foreground });
  colors.current = { background, foreground };

  useEffect(() => {
    refreshDeviceHubAccess(environmentId);
  }, [environmentId]);

  useEffect(() => {
    if (!access) return;
    let cancelled = false;
    setConfiguration(null);
    setViewerError(null);
    void (async () => {
      // A VM that just booted has no display address for a few seconds, so
      // early refusals are retried a bounded number of times before showing;
      // other failures (authorization, transport) fail fast.
      let result = await viewer({ environmentId, input: { desktopId: desktop.id } });
      for (
        let retry = 0;
        result._tag === "Failure" && isViewerRetryable(result.cause) && retry < VIEWER_RETRIES;
        retry++
      ) {
        await new Promise((resolve) => setTimeout(resolve, VIEWER_RETRY_MS));
        if (cancelled) return;
        result = await viewer({ environmentId, input: { desktopId: desktop.id } });
      }
      if (cancelled) return;
      if (result._tag === "Failure") {
        setViewerError("Couldn't connect to the desktop.");
        return;
      }
      const { path, password } = result.value;
      const next: DesktopStreamConfiguration = {
        url: computerDesktopViewerUrl(access, path),
        password,
        hasTicket: access.query.wsTicket !== undefined,
        ticketRefreshed: ticketRefreshed.current,
        colors: colors.current,
      };
      setConfiguration(JSON.stringify(next));
    })();
    return () => {
      cancelled = true;
    };
  }, [access, desktop.id, environmentId, viewer]);

  const onUnauthorized = useCallback(async () => {
    ticketRefreshed.current = true;
    refreshDeviceHubAccess(environmentId);
  }, [environmentId]);
  // A retry is one reconnect: fresh access re-runs the connect effect, which
  // mints new viewer credentials and remounts the WebView once.
  const onRetry = useCallback(() => {
    ticketRefreshed.current = false;
    refreshDeviceHubAccess(environmentId);
  }, [environmentId]);

  if (configuration !== null) {
    return (
      <StreamWebView
        script={desktopStreamScript}
        globalName="RoveDesktopStream"
        subject="desktop"
        configuration={configuration}
        background={background}
        onUnauthorized={onUnauthorized}
        onInputConnected={noInput}
        onRetry={onRetry}
      />
    );
  }
  const error = viewerError ?? accessError;
  return (
    <View className="flex-1 items-center justify-center gap-4 px-6">
      {error ? (
        <>
          <AppText selectable className="text-center text-sm text-foreground-muted">
            {error}
          </AppText>
          <Pressable
            accessibilityRole="button"
            className="rounded-full border border-secondary-border bg-secondary px-6 py-3"
            onPress={onRetry}
          >
            <AppText className="text-secondary-foreground">Try again</AppText>
          </Pressable>
        </>
      ) : (
        <>
          <AppActivityIndicator color={themeVariables["--color-icon"]} />
          <AppText className="text-sm text-foreground-muted">Connecting to desktop...</AppText>
        </>
      )}
    </View>
  );
}
