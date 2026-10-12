import { describe, expect, it } from "vite-plus/test";
import { MAX_RICH_RESPONSE_CHARS, type RichResponse } from "@rove-code/contracts/rich-response";
import {
  encodeRichResponse,
  parseRichResponse,
  richResponseTextFallback,
  splitRichResponse,
} from "./richResponse.ts";

const response: RichResponse = {
  version: 1,
  blocks: [
    { type: "text", text: "Choose an implementation." },
    {
      type: "table",
      title: "Options",
      columns: ["Option", "Trade-off"],
      rows: [
        ["Native", "Consistent"],
        ["HTML", "Flexible"],
      ],
    },
    { type: "details", title: "Why native?", text: "Works on mobile too." },
    {
      type: "choices",
      title: "Next step",
      options: [{ label: "Explore", prompt: "Explain the native approach." }],
    },
  ],
};

describe("rich responses", () => {
  it("round-trips the catalog and preserves prose around multiple responses", () => {
    expect(parseRichResponse(JSON.stringify(response))).toEqual(response);
    const source = `Before\n\n${encodeRichResponse(response)}\n\nBetween\n\n${encodeRichResponse(response)}\nAfter`;
    const segments = splitRichResponse(source);
    expect(segments.map((segment) => segment.kind)).toEqual([
      "markdown",
      "rich-response",
      "markdown",
      "rich-response",
      "markdown",
    ]);
    expect(segments[0]).toMatchObject({ text: "Before\n\n" });
    expect(segments.at(-1)).toMatchObject({ text: "\nAfter" });
  });

  it.each([
    { version: 2, blocks: response.blocks },
    { version: 1, blocks: [] },
    { version: 1, blocks: [{ type: "html", html: "<script>fetch('/api')</script>" }] },
    { version: 1, blocks: [{ type: "text", text: "Safe", onClick: "run-command" }] },
    {
      version: 1,
      blocks: [{ type: "table", title: "Broken", columns: ["A", "B"], rows: [["A"]] }],
    },
    {
      version: 1,
      blocks: [
        {
          type: "choices",
          title: "Bad action",
          options: [{ label: "Run", prompt: "Hello", action: "execute" }],
        },
      ],
    },
    { version: 1, blocks: Array.from({ length: 13 }, () => ({ type: "text", text: "Too many" })) },
    { version: 1, blocks: [{ type: "text", text: "x".repeat(8_001) }] },
  ])("leaves invalid or unsupported payloads literal: %j", (invalid) => {
    const json = JSON.stringify(invalid);
    expect(parseRichResponse(json)).toBeNull();
    const source = `\`\`\`rove-response\n${json}\n\`\`\``;
    expect(splitRichResponse(source)).toEqual([
      { kind: "markdown", sourceOffset: 0, text: source },
    ]);
    expect(richResponseTextFallback(source)).toBe(source);
  });

  it("bounds both serialized payload size and total decoded content", () => {
    expect(
      parseRichResponse(" ".repeat(MAX_RICH_RESPONSE_CHARS) + JSON.stringify(response)),
    ).toBeNull();
    expect(
      parseRichResponse(
        JSON.stringify({
          version: 1,
          blocks: Array.from({ length: 12 }, () => ({ type: "text", text: "x".repeat(8_000) })),
        }),
      ),
    ).toBeNull();
  });

  it("keeps examples in longer fences and escaped or indented markers literal", () => {
    for (const source of [
      `\`\`\`\`markdown\n${encodeRichResponse(response)}\n\`\`\`\``,
      `~~~markdown\n${encodeRichResponse(response)}\n~~~`,
      encodeRichResponse(response)
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n"),
      `\\${encodeRichResponse(response)}`,
    ])
      expect(splitRichResponse(source)).toEqual([
        { kind: "markdown", sourceOffset: 0, text: source },
      ]);
  });

  it.each([2, 3])("uses the Markdown AST fence offset for %s-space indentation", (indent) => {
    const source =
      "Before\n" +
      encodeRichResponse(response)
        .split("\n")
        .map((line) => " ".repeat(indent) + line)
        .join("\n");
    const segments = splitRichResponse(source);
    expect(segments[0]).toMatchObject({ kind: "markdown", text: "Before\n" });
    expect(segments[1]).toMatchObject({
      kind: "rich-response",
      sourceOffset: 7 + indent,
      response,
    });
    expect(splitRichResponse(source.slice(0, -3), true)[1]).toMatchObject({
      kind: "pending",
      sourceOffset: 7 + indent,
    });
  });

  it("supports CRLF and tilde fences without treating unrelated languages as responses", () => {
    const source = `~~~rove-response\r\n${JSON.stringify(response)}\r\n~~~`;
    expect(splitRichResponse(source)[0]).toMatchObject({ kind: "rich-response", response });
    const ordinary = `\`\`\`json\n${JSON.stringify(response)}\n\`\`\``;
    expect(splitRichResponse(ordinary)[0]).toMatchObject({ kind: "markdown", text: ordinary });
  });

  it("waits for a closing fence while streaming, and exposes interrupted source when finished", () => {
    const source = `Before\n\`\`\`rove-response\n${JSON.stringify(response)}`;
    expect(splitRichResponse(source, true)).toEqual([
      { kind: "markdown", sourceOffset: 0, text: "Before\n" },
      { kind: "pending", sourceOffset: 7 },
    ]);
    expect(splitRichResponse(source, false)).toEqual([
      { kind: "markdown", sourceOffset: 0, text: source },
    ]);
    expect(splitRichResponse(source + "\n```", true)[1]).toMatchObject({
      kind: "rich-response",
      response,
    });
  });

  it("copies readable content including collapsed details and the exact suggested follow-ups", () => {
    const fallback = richResponseTextFallback(`Before\n${encodeRichResponse(response)}\nAfter`);
    expect(fallback).toContain("| Native | Consistent |");
    expect(fallback).toContain("### Why native?\n\nWorks on mobile too.");
    expect(fallback).toContain("Explain the native approach.");
    expect(fallback).not.toContain("rove-response");
    expect(fallback).toMatch(/^Before\n/);
    expect(fallback).toMatch(/\nAfter$/);
  });

  it("keeps HTML and Markdown-looking leaf content as text in the fallback", () => {
    const plain: RichResponse = {
      version: 1,
      blocks: [{ type: "text", text: "<script>alert(1)</script> **not bold**" }],
    };
    expect(richResponseTextFallback(encodeRichResponse(plain))).toBe(
      "\\<script\\>alert(1)\\</script\\> \\*\\*not bold\\*\\*",
    );
  });
});
