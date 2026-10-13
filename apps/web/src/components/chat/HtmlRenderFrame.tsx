import type { EnvironmentId, ScopedThreadRef } from "@rove-code/contracts";
import type { RichResponseBlock } from "@rove-code/contracts/rich-response";
import {
  clampHtmlRenderHeight,
  htmlRenderFileName,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
} from "@rove-code/shared/htmlRender";
import { Maximize2Icon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { readLocalApi } from "~/localApi";
import { useRightPanelStore } from "~/rightPanelStore";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type HtmlBlock = Extract<RichResponseBlock, { type: "html" }>;

/**
 * An agent's interactive page inline in a reply. The page runs in a sandboxed
 * frame with an opaque origin (the server also sends a sandbox CSP), sits on
 * the thread's own background, and grows to the height it reports. The box
 * holds the agent's estimate while loading so the reply below barely moves.
 */
export const HtmlRenderFrame = memo(function HtmlRenderFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly block: HtmlBlock;
}) {
  const { attachmentId, title } = props.block;
  const fileName = htmlRenderFileName(title);
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId,
      fileName,
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [attachmentId, fileName],
  );
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const theme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [contentHeight, setContentHeight] = useState<number>();

  // The page keeps the URL and theme it first loaded with; later theme changes
  // are posted in, so switching themes never reloads (and resets) the page.
  const [src, setSrc] = useState<string | null>(null);
  const loadedUrl = assetUrl._tag === "Success" ? assetUrl.url : null;
  useEffect(() => {
    if (src === null && loadedUrl !== null) setSrc(loadedUrl + htmlRenderThemeFragment(theme));
  }, [loadedUrl, src, theme]);

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
  }, [theme]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const height = readHtmlRenderContentHeight(event.data);
      if (height !== undefined) {
        setContentHeight(height);
        return;
      }
      const url = readHtmlRenderLinkRequest(event.data);
      if (url !== undefined) void readLocalApi()?.shell.openExternal(url);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const height = clampHtmlRenderHeight(contentHeight ?? props.block.height);
  const threadRef = props.threadRef;

  return (
    <div className="group/html-render relative min-w-0" style={{ height }} data-html-render="">
      {src !== null ? (
        <>
          <iframe
            ref={frameRef}
            src={src}
            title={title}
            className="block size-full border-0 bg-transparent"
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
            allow="fullscreen; clipboard-write"
            allowFullScreen
          />
          {threadRef ? (
            <div className="absolute end-2 top-2 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={`Open ${title} in panel`}
                      size="icon-xs"
                      variant="glass"
                      onClick={() =>
                        useRightPanelStore.getState().openAttachment(threadRef, {
                          type: "file",
                          id: attachmentId,
                          name: fileName,
                          mimeType: "text/html",
                          // Unknown here; the preview hides it.
                          sizeBytes: 0,
                        })
                      }
                    />
                  }
                >
                  <Maximize2Icon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="left">Open in panel</TooltipPopup>
              </Tooltip>
            </div>
          ) : null}
        </>
      ) : assetUrl._tag === "Failure" ? (
        <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
          Unable to load {title}
        </p>
      ) : null}
    </div>
  );
});
