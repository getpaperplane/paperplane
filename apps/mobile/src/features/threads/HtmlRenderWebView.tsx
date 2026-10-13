import type { EnvironmentId } from "@rove-code/contracts";
import type { RichResponseBlock } from "@rove-code/contracts/rich-response";
import {
  chartVariables,
  clampHtmlRenderHeight,
  htmlRenderFileName,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
  type HtmlRenderTheme,
} from "@rove-code/shared/htmlRender";
import { HTML_RENDER_MAX_HEIGHT } from "@rove-code/contracts/rich-response";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";

import { AppText as Text } from "../../components/AppText";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useAssetUrlState } from "../../state/assets";

type HtmlBlock = Extract<RichResponseBlock, { type: "html" }>;

const FONT_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif';
const FONT_MONO = 'Menlo, "SF Mono", "Roboto Mono", monospace';

/** The mobile palette mapped onto the variables pages style against. */
function useMobileHtmlRenderTheme(): HtmlRenderTheme {
  const { themeVariables: colors, themeAppearance } = useAppearancePreferences();
  return useMemo(
    () => ({
      appearance: themeAppearance,
      variables: {
        "--background": colors["--color-thread-canvas"],
        "--foreground": colors["--color-foreground"],
        "--muted": colors["--color-subtle"],
        "--muted-foreground": colors["--color-foreground-muted"],
        "--card": colors["--color-card"],
        "--card-foreground": colors["--color-foreground"],
        "--border": colors["--color-border"],
        "--primary": colors["--color-primary"],
        "--primary-foreground": colors["--color-primary-foreground"],
        "--accent": colors["--color-subtle-strong"],
        "--accent-foreground": colors["--color-foreground"],
        "--destructive": colors["--color-danger"],
        "--warning": colors["--color-warning"],
        "--success": themeAppearance === "dark" ? "#34d399" : "#059669",
        "--info": themeAppearance === "dark" ? "#60a5fa" : "#2563eb",
        ...chartVariables(themeAppearance),
        "--radius": "0.625rem",
        "--font-sans": FONT_SANS,
        "--font-mono": FONT_MONO,
      },
    }),
    [colors, themeAppearance],
  );
}

const withoutFragment = (url: string) => url.split("#", 1)[0];

/**
 * An agent's interactive page inline in a reply. The page reports its height
 * through `window.ReactNativeWebView`, so the view grows to fit it and the feed,
 * not the page, owns vertical scrolling. Links open in the system browser.
 */
export const HtmlRenderWebView = memo(function HtmlRenderWebView(props: {
  readonly environmentId: EnvironmentId;
  readonly block: HtmlBlock;
}) {
  const { attachmentId, title } = props.block;
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId,
      fileName: htmlRenderFileName(title),
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [attachmentId, title],
  );
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const theme = useMobileHtmlRenderTheme();
  const webViewRef = useRef<WebView>(null);
  const [contentHeight, setContentHeight] = useState<number>();

  // The page keeps the URL and theme it first loaded with; later theme changes
  // are posted in, so switching themes never reloads (and resets) the page.
  const [src, setSrc] = useState<string | null>(null);
  const loadedUrl = assetUrl._tag === "Success" ? assetUrl.url : null;
  useEffect(() => {
    if (src === null && loadedUrl !== null) setSrc(loadedUrl + htmlRenderThemeFragment(theme));
  }, [loadedUrl, src, theme]);

  useEffect(() => {
    const message = JSON.stringify(htmlRenderThemeMessage(theme));
    webViewRef.current?.injectJavaScript(
      `window.dispatchEvent(new MessageEvent("message",{data:${message}}));true;`,
    );
  }, [theme]);

  const height = clampHtmlRenderHeight(contentHeight ?? props.block.height);
  // A page taller than the cap scrolls inside; otherwise the feed keeps the gesture.
  const scrollsInside = contentHeight !== undefined && contentHeight > HTML_RENDER_MAX_HEIGHT;

  return (
    <View style={{ height }} accessibilityLabel={title}>
      {src !== null ? (
        <WebView
          ref={webViewRef}
          source={{ uri: src }}
          originWhitelist={["*"]}
          scrollEnabled={scrollsInside}
          nestedScrollEnabled={scrollsInside}
          allowsInlineMediaPlayback
          allowsFullscreenVideo
          mediaPlaybackRequiresUserAction
          setSupportMultipleWindows={false}
          onMessage={(event) => {
            const data = event.nativeEvent.data;
            const reported = readHtmlRenderContentHeight(data);
            if (reported !== undefined) {
              setContentHeight(reported);
              return;
            }
            const url = readHtmlRenderLinkRequest(data);
            if (url !== undefined) void tryOpenExternalUrl(url, "markdown-link");
          }}
          onShouldStartLoadWithRequest={(request) => {
            // The page itself, its frames, and in-page anchors load here; anything
            // else would replace the page inside the thread, so it opens outside.
            if (!request.isTopFrame || withoutFragment(request.url) === withoutFragment(src)) {
              return true;
            }
            if (/^https?:\/\//i.test(request.url)) {
              void tryOpenExternalUrl(request.url, "markdown-link");
            }
            return false;
          }}
          style={{ flex: 1, backgroundColor: "transparent" }}
        />
      ) : assetUrl._tag === "Failure" ? (
        <View className="flex-1 items-center justify-center">
          <Text className="text-xs text-foreground-muted">Unable to load {title}</Text>
        </View>
      ) : null}
    </View>
  );
});
