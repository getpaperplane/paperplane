import * as Schema from "effect/Schema";

export const RICH_RESPONSE_FENCE = "rove-response";
export const MAX_RICH_RESPONSE_CHARS = 48_000;

const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000));
const Cell = Schema.String.check(Schema.isMaxLength(2_000));

export const HTML_RENDER_MIN_HEIGHT = 80;
export const HTML_RENDER_MAX_HEIGHT = 2_000;
export const HTML_RENDER_DEFAULT_HEIGHT = 360;

/**
 * An interactive page the `html_render` tool stored in the thread's attachment
 * store. Only the reference travels in message text; clients load the page
 * into a sandboxed frame with an opaque origin.
 */
const HtmlRenderAttachmentId = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.isPattern(
    /^[a-z0-9_]+(?:-[a-z0-9_]+)*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-html$/,
  ),
);

/**
 * Blocks clients render natively. `html` is the current interactive format;
 * `table`, `details`, and `choices` are kept so replies written before it
 * still render. All leaf content other than the stored page is plain text.
 */
export const RichResponseBlock = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Text }),
  Schema.Struct({
    type: Schema.Literal("table"),
    title: Label,
    columns: Schema.Array(Label).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
    rows: Schema.Array(Schema.Array(Cell).check(Schema.isMaxLength(8))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(40),
    ),
  }).check(
    Schema.makeFilter(({ columns, rows }) => rows.every((row) => row.length === columns.length), {
      title: "Every table row must have one cell per column",
    }),
  ),
  Schema.Struct({ type: Schema.Literal("details"), title: Label, text: Text }),
  Schema.Struct({
    type: Schema.Literal("html"),
    attachmentId: HtmlRenderAttachmentId,
    title: Label,
    /** The agent's estimate, reserved until the page reports its own height. */
    height: Schema.Int.check(
      Schema.isBetween({ minimum: HTML_RENDER_MIN_HEIGHT, maximum: HTML_RENDER_MAX_HEIGHT }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("choices"),
    title: Label,
    options: Schema.Array(Schema.Struct({ label: Label, prompt: Text })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(6),
    ),
  }),
]);
export type RichResponseBlock = typeof RichResponseBlock.Type;

export const RichResponse = Schema.Struct({
  version: Schema.Literal(1),
  blocks: Schema.Array(RichResponseBlock).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
}).check(
  Schema.makeFilter((response) => JSON.stringify(response).length <= MAX_RICH_RESPONSE_CHARS, {
    title: "Rich response must fit within 48,000 characters",
  }),
);
export type RichResponse = typeof RichResponse.Type;
