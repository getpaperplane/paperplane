import remarkParse from "remark-parse";
import { unified } from "unified";

import { CHAT_MARKDOWN_REMARK_PLUGINS } from "./markdownPipeline.ts";

/** A top-level slice of a Markdown document that renders on its own. */
export interface MarkdownBlock {
  /** Absolute offset of `source` in the document. */
  readonly offset: number;
  readonly source: string;
}

export interface MarkdownBlockSplit {
  /** Changes whenever the document was replaced rather than extended. */
  readonly generation: number;
  /** Finished blocks. The array keeps its identity until another block finishes. */
  readonly committed: ReadonlyArray<MarkdownBlock>;
  /** Everything after the finished blocks; it is reparsed as the document grows. */
  readonly tail: MarkdownBlock;
}

type MarkdownNode = {
  readonly type: string;
  readonly value?: string;
  readonly position?: { readonly start: { readonly offset?: number } };
  readonly children?: ReadonlyArray<MarkdownNode>;
};

// Parsing never runs transforms, so only the plugins' syntax extensions apply.
const blockParser = unified().use(remarkParse).use(CHAT_MARKDOWN_REMARK_PLUGINS).freeze();

const VOID_HTML_TAG = /^<(?:br|hr|img|wbr)\b[^<>]*\/?>$/i;
const HTML_ID_ATTRIBUTE = /\b(?:id|name)\s*=/i;

function some(node: MarkdownNode, predicate: (node: MarkdownNode) => boolean): boolean {
  return predicate(node) || (node.children?.some((child) => some(child, predicate)) ?? false);
}

const isDefinition = (node: MarkdownNode) =>
  node.type === "definition" || node.type === "footnoteDefinition";

// Raw HTML is reassembled across blocks by rehype-raw: an open `<div>` adopts
// later blocks and an unclosed `<b>` is reconstructed in the next paragraph.
// Void tags cannot leave an element open.
const isOpenableHtml = (node: MarkdownNode) =>
  node.type === "html" && !VOID_HTML_TAG.test(node.value?.trim() ?? "");

// Authored ids shift the suffixes rehypeHeadingIds gives to earlier headings.
const isHtmlWithId = (node: MarkdownNode) =>
  node.type === "html" && HTML_ID_ATTRIBUTE.test(node.value ?? "");

/**
 * Splits a streaming Markdown document into finished top-level blocks and a
 * tail. A block is finished once the parser starts another top-level node after
 * it: Markdown can only extend the last open block. Rendering each block alone
 * matches rendering the document, joined by the newline the HTML compiler puts
 * between top-level nodes, except where a node depends on the rest of the
 * document. Those documents return `null` and render whole:
 *
 * - Link and footnote definitions resolve references anywhere in the document.
 * - Top-level raw HTML changes the standalone-image and anchor passes, which
 *   inspect the root's children.
 * - Raw HTML with an `id` or `name` changes earlier heading ids.
 *
 * Blocks containing other raw HTML stay in the tail, so they render with
 * everything after them. Once a document renders whole it stays whole until it
 * is replaced rather than extended, so the DOM is never rebuilt mid-stream.
 */
export function createMarkdownBlockSplitter() {
  let committed: MarkdownBlock[] = [];
  let committedEnd = 0;
  let previous: string | undefined;
  let whole = false;
  let generation = 0;

  const reset = () => {
    generation += 1;
    committed = [];
    committedEnd = 0;
    whole = false;
  };

  return (text: string): MarkdownBlockSplit | null => {
    if (previous === undefined || !text.startsWith(previous)) reset();
    previous = text;
    // A streaming CR can become half of a CRLF, and a BOM at a block boundary
    // would be stripped by the block's own parse.
    if (whole || text.includes("\r") || text.includes("\uFEFF")) {
      whole = true;
      return null;
    }

    const tailSource = text.slice(committedEnd);
    // SAFETY: remark-parse returns an mdast root, which MarkdownNode describes structurally.
    const root = blockParser.parse(tailSource) as MarkdownNode;
    const children = root.children ?? [];
    if (
      some(root, isDefinition) ||
      some(root, isHtmlWithId) ||
      children.some((child) => child.type === "html")
    ) {
      whole = true;
      return null;
    }

    let blockStart = 0;
    const finished: MarkdownBlock[] = [];
    for (let index = 0; index < children.length - 1; index++) {
      if (some(children[index]!, isOpenableHtml)) break;
      const nextStart = children[index + 1]!.position?.start.offset;
      if (nextStart === undefined) break;
      // Cut at the start of the next node's line so indentation stays with it.
      const boundary = tailSource.lastIndexOf("\n", nextStart - 1) + 1;
      if (boundary <= blockStart) continue;
      finished.push({
        offset: committedEnd + blockStart,
        source: tailSource.slice(blockStart, boundary),
      });
      blockStart = boundary;
    }
    if (finished.length > 0) {
      committed = [...committed, ...finished];
      committedEnd += blockStart;
    }
    return {
      generation,
      committed,
      tail: { offset: committedEnd, source: text.slice(committedEnd) },
    };
  };
}
