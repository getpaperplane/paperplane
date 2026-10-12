import { RichResponse } from "@rove-code/contracts/rich-response";
import { encodeRichResponse } from "@rove-code/shared/richResponse";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

class RichResponseValidationError extends Schema.TaggedError<RichResponseValidationError>()(
  "RichResponseValidationError",
  { message: Schema.String },
) {}

const document = Schema.toJsonSchemaDocument(RichResponse, { onExcessProperty: "error" });
const decodeResponse = Schema.decodeUnknownEffect(RichResponse, { onExcessProperty: "error" });

export const RichResponseToolkit = Toolkit.make(
  // Raw parameters keep unknown fields intact until our strict decoder validates them.
  Tool.dynamic("prepare_rich_response", {
    description:
      "Validate and prepare native rich content for your final response. Use tables for comparisons, details for optional explanations, and choices for suggested follow-ups. All content is rendered as literal text, not HTML, JavaScript, CSS, or active links. Executable actions are not supported. Choices only copy their prompt, never send it. This tool does not publish a message: include the returned responseMarkdown verbatim in your final answer. If unavailable, use ordinary Markdown.",
    parameters: { ...document.schema, $defs: document.definitions },
    success: Schema.Struct({ responseMarkdown: Schema.String }),
    failure: RichResponseValidationError,
  }).annotate(Tool.Readonly, true),
);

export const RichResponseToolkitHandlersLive = RichResponseToolkit.toLayer({
  prepare_rich_response: (input) =>
    decodeResponse(input).pipe(
      Effect.map((response) => ({
        responseMarkdown: encodeRichResponse(response),
      })),
      Effect.mapError((error) => new RichResponseValidationError({ message: error.message })),
    ),
});
