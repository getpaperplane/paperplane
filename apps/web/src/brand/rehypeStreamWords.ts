/**
 * Wraps each word of a streaming block in `<span class="stream-word">` so
 * CSS can fade new words in as they arrive (see `brand/paperplane.css`).
 *
 * Only the growing tail block of a streaming reply uses this. React keeps the
 * spans it already rendered and inserts only the new ones, so each word fades
 * once. When the block finishes, the plugin is dropped and the block renders
 * as plain text again.
 */

interface HastText {
  type: "text";
  value: string;
}

interface HastParent {
  type: string;
  tagName?: string;
  properties?: object;
  children: HastNode[];
}

type HastNode = HastText | HastParent | { type: "comment" | "raw" | "doctype"; value?: string };

/** Code, links and math keep their own text handling. */
const SKIP_TAGS = new Set(["pre", "code", "a", "svg", "math", "script", "style"]);

const isText = (node: HastNode): node is HastText => node.type === "text";
const isParent = (node: HastNode): node is HastParent => "children" in node;

function wrapWords(text: HastText): HastNode[] {
  return text.value.split(/(\s+)/).flatMap((part): HastNode[] => {
    if (part === "") return [];
    if (/^\s+$/.test(part)) return [{ type: "text", value: part }];
    return [
      {
        type: "element",
        tagName: "span",
        properties: { className: ["stream-word"] },
        children: [{ type: "text", value: part }],
      },
    ];
  });
}

function visit(node: HastParent): void {
  if (node.tagName !== undefined && SKIP_TAGS.has(node.tagName)) return;
  node.children = node.children.flatMap((child) => {
    if (isText(child)) return wrapWords(child);
    if (isParent(child)) visit(child);
    return [child];
  });
}

export function rehypeStreamWords() {
  return (tree: HastParent) => visit(tree);
}
