import { describe, expect, it } from "vite-plus/test";

import { rehypeStreamWords } from "./rehypeStreamWords";

type Tree = Parameters<ReturnType<typeof rehypeStreamWords>>[0];
type Node = Tree["children"][number];

const text = (value: string): Node => ({ type: "text", value });
const element = (tagName: string, children: Node[]): Tree => ({
  type: "element",
  tagName,
  properties: {},
  children,
});

describe("rehypeStreamWords", () => {
  it("wraps prose words, keeps whitespace, and leaves code and links alone", () => {
    const tree = element("root", [
      element("p", [
        text("Hello  there "),
        element("code", [text("a b")]),
        element("a", [text("docs link")]),
      ]),
    ]);
    rehypeStreamWords()(tree);
    expect(tree).toEqual(
      element("root", [
        element("p", [
          {
            type: "element",
            tagName: "span",
            properties: { className: ["stream-word"] },
            children: [text("Hello")],
          },
          text("  "),
          {
            type: "element",
            tagName: "span",
            properties: { className: ["stream-word"] },
            children: [text("there")],
          },
          text(" "),
          element("code", [text("a b")]),
          element("a", [text("docs link")]),
        ]),
      ]),
    );
  });
});
