import { describe, expect, it } from "vite-plus/test";

import { createMarkdownBlockSplitter } from "./markdownStreamingBlocks.ts";

function stream(source: string) {
  const split = createMarkdownBlockSplitter();
  let result = split("");
  for (let end = 1; end <= source.length; end++) result = split(source.slice(0, end));
  return result;
}

describe("createMarkdownBlockSplitter", () => {
  it("finishes a block once the next one starts, keeping the boundary at a line start", () => {
    const result = stream("# Title\n\nFirst paragraph.\n\n    indented code\n\n- item\n\n  more");
    expect(result?.committed.map((block) => block.source)).toEqual([
      "# Title\n\n",
      "First paragraph.\n\n",
      "    indented code\n\n",
    ]);
    expect(result?.tail).toEqual({ offset: 46, source: "- item\n\n  more" });
  });

  it("never finishes an open fence, list, or table", () => {
    for (const source of [
      "```ts\nconst a = 1;\n\n\nconst b = 2;",
      "- a\n\n  - b\n\n    continued",
      "| a | b |\n| - | - |\n| 1 | 2 |",
    ]) {
      expect(stream(source)?.committed).toEqual([]);
    }
  });

  it("keeps the committed array while the tail grows", () => {
    const split = createMarkdownBlockSplitter();
    const first = split("one\n\ntw");
    expect(split("one\n\ntwo")?.committed).toBe(first?.committed);
  });

  it("renders whole documents that depend on later content, until replaced", () => {
    for (const source of [
      "[ref]\n\nnext\n\n[ref]: https://example.com",
      "note[^n]\n\n[^n]: text",
      "text\n\n<div>\n\nhello\n\n</div>",
      'text <span id="target">a</span>\n\nnext',
      "first\r\n\r\nsecond",
    ]) {
      const split = createMarkdownBlockSplitter();
      expect(split(source)).toBeNull();
      expect(split(`${source}\n\nmore`)).toBeNull();
      expect(split("replacement\n\ntext")).not.toBeNull();
    }
  });

  it("keeps blocks with tags that can stay open in the tail", () => {
    expect(stream("a <b>bold\n\nnext</b> para\n\nend")?.committed).toEqual([]);
    expect(
      stream("line<br>break\n\nnext <kbd>K</kbd>\n\nend")?.committed.map((block) => block.source),
    ).toEqual(["line<br>break\n\n"]);
  });

  it("starts a new generation when the document is replaced", () => {
    const split = createMarkdownBlockSplitter();
    const generation = split("one\n\ntwo")?.generation;
    expect(split("one\n\ntwo three")?.generation).toBe(generation);
    expect(split("other")?.generation).not.toBe(generation);
  });
});
