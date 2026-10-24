import type { ResponseStreamingMode } from "@getpaperplane/contracts";
import type * as ProviderAdapter from "@getpaperplane/provider-core/server/ProviderAdapter";

// An opening fence may sit at any indentation, since fences inside list
// items are indented past the marker. A closing fence may be indented at most
// three spaces more than its opener. Deeper lines are content in the block.
const MARKDOWN_FENCE_PATTERN = /^( *)(`{3,}|~{3,})/;
// CommonMark blank lines hold only spaces and tabs. Other whitespace, such as
// a no-break space, is paragraph content.
const BLANK_LINE_PATTERN = /^[ \t]*$/;
// A bullet or ordered marker followed by whitespace, at any indentation so
// nested items count. The trailing space is required, so a partial `-` or
// `1.` never matches before the model finishes the marker.
const LIST_ITEM_START_PATTERN = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/;
// A section title: an ATX heading, or a line of only bold text, which models
// often use as a heading.
const SECTION_TITLE_PATTERN = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|\*\*(?:[^*]|\*(?!\*))+\*\*:?$)/;
// An unindented ATX heading ends the paragraph or list above it, even with no
// blank line between them. A bold line would continue the paragraph instead.
const TOP_LEVEL_HEADING_PATTERN = /^#{1,6}(?:[ \t]|$)/;

interface BufferedAssistantScan {
  text: string;
  openFence: { marker: string; indent: number } | null;
  boundary: number;
  lineStart: number;
  searchedThrough: number;
  titleAwaitingContent: boolean;
}

const makeBufferedAssistantScan = (): BufferedAssistantScan => ({
  text: "",
  openFence: null,
  boundary: -1,
  lineStart: 0,
  searchedThrough: 0,
  titleAwaitingContent: false,
});

// Only complete lines advance markdown state. Revisit the final partial line
// for tight-list lookahead; an edited/shrunk snapshot starts over.
function scanBufferedAssistantText(text: string, scan: BufferedAssistantScan) {
  if (!text.startsWith(scan.text)) Object.assign(scan, makeBufferedAssistantScan());
  let boundary = scan.boundary;
  for (;;) {
    const newline = text.indexOf("\n", scan.searchedThrough);
    if (newline === -1) {
      scan.searchedThrough = text.length;
      if (
        scan.openFence === null &&
        scan.lineStart > 0 &&
        !scan.titleAwaitingContent &&
        LIST_ITEM_START_PATTERN.test(text.slice(scan.lineStart).replace(/[ \t\r]+$/, ""))
      ) {
        boundary = scan.lineStart;
      }
      break;
    }
    const line = text.slice(scan.lineStart, newline).replace(/[ \t\r]+$/, "");
    if (
      scan.openFence === null &&
      scan.lineStart > 0 &&
      !scan.titleAwaitingContent &&
      LIST_ITEM_START_PATTERN.test(line)
    ) {
      boundary = scan.lineStart;
    }
    const fenceMatch = MARKDOWN_FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      const indent = fenceMatch[1]!.length;
      const marker = fenceMatch[2]!;
      if (scan.openFence === null) {
        scan.openFence = { marker, indent };
        scan.titleAwaitingContent = false;
      } else if (
        marker[0] === scan.openFence.marker[0] &&
        marker.length >= scan.openFence.marker.length &&
        indent <= scan.openFence.indent + 3 &&
        line.length === indent + marker.length
      ) {
        // CommonMark: a closing fence carries no info string.
        scan.openFence = null;
        boundary = newline + 1;
      }
    } else if (scan.openFence === null && BLANK_LINE_PATTERN.test(line) && scan.lineStart > 0) {
      if (!scan.titleAwaitingContent) boundary = newline + 1;
    } else if (scan.openFence === null) {
      if (
        scan.lineStart > 0 &&
        !scan.titleAwaitingContent &&
        TOP_LEVEL_HEADING_PATTERN.test(line)
      ) {
        boundary = scan.lineStart;
      }
      scan.titleAwaitingContent = SECTION_TITLE_PATTERN.test(line);
    }
    scan.lineStart = newline + 1;
    scan.searchedThrough = scan.lineStart;
    scan.boundary = boundary;
  }
  scan.text = text;
  return boundary;
}

/**
 * Splits buffered assistant text at the last blank line, closing code fence,
 * or list item start that is not inside an open fenced code block. `ready` is
 * safe to deliver now because the markdown before it will not change shape as
 * more text arrives. `rest` stays buffered until the next boundary or
 * completion. Only fully terminated lines count, so a trailing partial line
 * never leaks; a list item start is the one lookahead that may sit on the
 * partial line, since tight lists have no blank lines between items and would
 * otherwise land all at once.
 *
 * A section title holds the boundary until a content line follows it, so a
 * title never lands alone and waits above a block that is still streaming.
 */
export function splitBufferedAssistantText(text: string): { ready: string; rest: string } {
  const boundary = scanBufferedAssistantText(text, makeBufferedAssistantScan());
  if (boundary === -1) {
    return { ready: "", rest: text };
  }
  return { ready: text.slice(0, boundary), rest: text.slice(boundary) };
}

/** Buffer assistant messages and reasoning alike, keeping unfinished markdown out of the read model. */
export function makeAssistantStreamingFilter(mode: ResponseStreamingMode) {
  const delivered = new Map<string, { text: string; at: number; scan: BufferedAssistantScan }>();
  return (
    event: ProviderAdapter.ProviderAdapterV2Event,
    now: number,
  ): ProviderAdapter.ProviderAdapterV2Event | null => {
    if (
      event.type === "node.updated" &&
      event.node.kind === "assistant_message" &&
      event.node.status === "running"
    )
      return null;
    const message =
      event.type === "message.updated" && event.message.role === "assistant"
        ? event.message
        : event.type === "turn_item.updated" &&
            (event.turnItem.type === "assistant_message" || event.turnItem.type === "reasoning")
          ? event.turnItem
          : null;
    if (!message) return event;
    const key = `${event.type}:${message.id}`;
    if (!message.streaming) {
      delivered.delete(key);
      return event;
    }
    if (mode === "turn") return null;
    const previous = delivered.get(key);
    if (previous && now - previous.at < 400) return null;
    const state = previous ?? { text: "", at: now, scan: makeBufferedAssistantScan() };
    // Throttle scans even when no boundary is ready or it has not advanced.
    state.at = now;
    delivered.set(key, state);
    const boundary = scanBufferedAssistantText(message.text, state.scan);
    const ready = boundary === -1 ? "" : message.text.slice(0, boundary);
    if (!ready || ready === state.text) return null;
    state.text = ready;
    if (event.type === "message.updated")
      return { ...event, message: { ...event.message, text: ready } };
    if (
      event.type === "turn_item.updated" &&
      (event.turnItem.type === "assistant_message" || event.turnItem.type === "reasoning")
    )
      return { ...event, turnItem: { ...event.turnItem, text: ready } };
    return event;
  };
}
