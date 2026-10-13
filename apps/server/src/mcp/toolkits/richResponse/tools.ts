import {
  HTML_RENDER_DEFAULT_HEIGHT,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MIN_HEIGHT,
} from "@rove-code/contracts/rich-response";
import {
  HTML_RENDER_PAGE_GUIDE,
  HTML_RENDER_TOOL_NAME,
  clampHtmlRenderHeight,
  injectHtmlRenderBootstrap,
} from "@rove-code/shared/htmlRender";
import { encodeRichResponse } from "@rove-code/shared/richResponse";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import { resolveAttachmentRelativePath } from "../../../attachmentPaths.ts";
import { createAttachmentId } from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { inlineLocalMedia } from "./inlineLocalMedia.ts";

/** Pages are written by hand or generated; anything larger belongs in a file the user opens. */
export const HTML_RENDER_MAX_SOURCE_CHARS = 1_000_000;

class HtmlRenderError extends Schema.TaggedError<HtmlRenderError>()("HtmlRenderError", {
  message: Schema.String,
}) {}

const RICH_RESPONSES_OFF =
  "Rich responses are turned off in Rove Code settings. Answer in Markdown instead and do not call html_render again in this session.";

const HtmlRenderTool = Tool.make(HTML_RENDER_TOOL_NAME, {
  description: [
    "Publish an interactive HTML page (chart, diagram, dashboard, filterable table, image gallery, video, mockup) into this thread.",
    "It returns responseMarkdown: put it verbatim in your reply where the page belongs. The reader sees and can use the page there, so do not restate it.",
    "Write one self-contained document with inline <style> and <script>. Remote http(s) resources such as a CDN chart library load as-is.",
    "Local images, videos, and audio written as absolute file paths (in attributes, CSS url(), or script strings) are embedded automatically.",
    "Scripts run in a sandbox with no access to Rove Code; links open in the user's browser.",
    HTML_RENDER_PAGE_GUIDE,
  ].join(" "),
  parameters: Schema.Struct({
    html: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(HTML_RENDER_MAX_SOURCE_CHARS),
    ).annotate({ description: "A complete, self-contained HTML document." }),
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
      description: "Short name for the page, shown when it is opened full size or copied.",
    }),
    height: Schema.optional(
      Schema.Int.annotate({
        description: `Estimated page height in CSS pixels at about 720px wide, ${HTML_RENDER_MIN_HEIGHT}-${HTML_RENDER_MAX_HEIGHT}. Reserved while the page loads; the frame then fits the page. Defaults to ${HTML_RENDER_DEFAULT_HEIGHT}.`,
      }),
    ),
  }),
  success: Schema.Struct({
    responseMarkdown: Schema.String,
    missingFiles: Schema.optional(Schema.Array(Schema.String)),
  }),
  failure: HtmlRenderError,
  dependencies: [McpInvocationContext],
})
  .annotate(Tool.Title, "Render HTML")
  // Read-only in the MCP sense: the page lands in this thread's own attachment
  // store and touches no workspace, so plan mode and read-only sandboxes can use it.
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const RichResponseToolkit = Toolkit.make(HtmlRenderTool);

export const RichResponseToolkitHandlersLive = RichResponseToolkit.toLayer(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const settings = yield* ServerSettingsService;
    return RichResponseToolkit.of({
      html_render: (input) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext;
          // The capability fixes the prompt when the session starts; the live
          // setting makes turning rich responses off apply to running agents too.
          const enabled = yield* settings.getSettings.pipe(
            Effect.map((current) => current.enableRichResponses),
            Effect.orElseSucceed(() => false),
          );
          if (!scope.capabilities.has("rich-responses") || !enabled) {
            return yield* new HtmlRenderError({ message: RICH_RESPONSES_OFF });
          }
          const inlined = yield* inlineLocalMedia(input.html).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.mapError((error) => new HtmlRenderError({ message: error.message })),
          );
          const attachmentId = createAttachmentId(scope.threadId, "html");
          const filePath =
            attachmentId === null
              ? null
              : resolveAttachmentRelativePath({
                  attachmentsDir: config.attachmentsDir,
                  relativePath: `${attachmentId}.html`,
                });
          if (attachmentId === null || filePath === null) {
            return yield* new HtmlRenderError({
              message: "This thread cannot store pages. Answer in Markdown instead.",
            });
          }
          yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(
            Effect.andThen(
              fileSystem.writeFileString(filePath, injectHtmlRenderBootstrap(inlined.html)),
            ),
            Effect.mapError(
              () =>
                new HtmlRenderError({
                  message: "Could not save the page. Answer in Markdown instead.",
                }),
            ),
          );
          const responseMarkdown = encodeRichResponse({
            version: 1,
            blocks: [
              {
                type: "html",
                attachmentId,
                title: input.title.trim() || "Page",
                height: clampHtmlRenderHeight(input.height ?? HTML_RENDER_DEFAULT_HEIGHT),
              },
            ],
          });
          // Unresolved paths stay as written; the agent decides whether they matter.
          return inlined.missing.length > 0
            ? { responseMarkdown, missingFiles: inlined.missing }
            : { responseMarkdown };
        }),
    });
  }),
);
