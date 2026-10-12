import {
  MAX_RICH_RESPONSE_CHARS,
  RICH_RESPONSE_FENCE,
  RichResponse,
} from "@rove-code/contracts/rich-response";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeResponse = Schema.decodeUnknownOption(Schema.fromJsonString(RichResponse), {
  onExcessProperty: "error",
});

export function parseRichResponse(source: string): RichResponse | null {
  // A fence body includes the line ending before its closing marker.
  if (source.length > MAX_RICH_RESPONSE_CHARS + 2) return null;
  return Option.getOrNull(decodeResponse(source));
}

export function encodeRichResponse(response: RichResponse): string {
  return `\`\`\`${RICH_RESPONSE_FENCE}\n${JSON.stringify(response)}\n\`\`\``;
}

export type RichResponseSegment =
  | { readonly kind: "markdown"; readonly sourceOffset: number; readonly text: string }
  | {
      readonly kind: "rich-response";
      readonly sourceOffset: number;
      readonly response: RichResponse;
    }
  | { readonly kind: "pending"; readonly sourceOffset: number };

/** Only complete, top-level fences are promoted; examples inside other fences stay literal. */
export function splitRichResponse(text: string, isStreaming = false): RichResponseSegment[] {
  if (!text.includes(RICH_RESPONSE_FENCE)) return [{ kind: "markdown", sourceOffset: 0, text }];
  const segments: RichResponseSegment[] = [];
  let cursor = 0;
  let open:
    | { marker: string; start: number; sourceOffset: number; contentStart: number; rich: boolean }
    | undefined;
  for (const match of text.matchAll(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/gm)) {
    const marker = match[1]!;
    const info = match[2]!.trim();
    if (!open) {
      // Backtick info strings cannot themselves contain a backtick (CommonMark).
      if (marker[0] === "`" && info.includes("`")) continue;
      open = {
        marker,
        start: match.index,
        // Markdown AST offsets exclude the optional indentation before a fence.
        sourceOffset: match.index + match[0].indexOf(marker),
        contentStart: match.index + match[0].length + 1,
        rich: info === RICH_RESPONSE_FENCE,
      };
      continue;
    }
    if (marker[0] !== open.marker[0] || marker.length < open.marker.length || info !== "") continue;
    if (open.rich) {
      const response = parseRichResponse(text.slice(open.contentStart, match.index));
      if (response) {
        if (cursor < open.start) {
          segments.push({
            kind: "markdown",
            sourceOffset: cursor,
            text: text.slice(cursor, open.start),
          });
        }
        segments.push({ kind: "rich-response", sourceOffset: open.sourceOffset, response });
        cursor = match.index + match[0].length;
      }
    }
    open = undefined;
  }
  if (isStreaming && open?.rich && text.length - open.contentStart <= MAX_RICH_RESPONSE_CHARS + 2) {
    if (cursor < open.start) {
      segments.push({
        kind: "markdown",
        sourceOffset: cursor,
        text: text.slice(cursor, open.start),
      });
    }
    segments.push({ kind: "pending", sourceOffset: open.sourceOffset });
  } else if (cursor < text.length || segments.length === 0) {
    segments.push({ kind: "markdown", sourceOffset: cursor, text: text.slice(cursor) });
  }
  return segments;
}

const escapeMarkdown = (text: string) => text.replaceAll(/([\\`*_{}[\]<>#!|])/g, "\\$1");

/** Readable fallback for clipboard/export; no generated UI syntax or executable content. */
export function richResponseToMarkdown(response: RichResponse): string {
  return response.blocks
    .map((block) => {
      switch (block.type) {
        case "text":
          return escapeMarkdown(block.text);
        case "details":
          return `### ${escapeMarkdown(block.title)}\n\n${escapeMarkdown(block.text)}`;
        case "table": {
          const row = (cells: readonly string[]) =>
            `| ${cells.map((cell) => escapeMarkdown(cell).replaceAll(/\r?\n/g, " ")).join(" | ")} |`;
          return `### ${escapeMarkdown(block.title)}\n\n${row(block.columns)}\n${row(block.columns.map(() => "---"))}\n${block.rows.map(row).join("\n")}`;
        }
        case "choices":
          return `### ${escapeMarkdown(block.title)}\n\n${block.options.map((option) => `- **${escapeMarkdown(option.label)}**: ${escapeMarkdown(option.prompt)}`).join("\n")}`;
      }
    })
    .join("\n\n");
}

export function richResponseTextFallback(text: string): string {
  return splitRichResponse(text)
    .map((segment) =>
      segment.kind === "rich-response"
        ? richResponseToMarkdown(segment.response)
        : segment.kind === "markdown"
          ? segment.text
          : "",
    )
    .join("");
}
