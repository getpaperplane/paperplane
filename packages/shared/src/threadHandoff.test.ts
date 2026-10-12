import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  type ThreadHandoff,
  type ThreadHandoffItem,
} from "@rove-code/contracts";
import {
  readHandoffPage,
  renderHandoffContext,
  selectHandoffItems,
  portableHandoffText,
} from "./threadHandoff.ts";

const item = (id: string, role: "user" | "assistant", text: string): ThreadHandoffItem => ({
  id,
  role,
  kind: "message",
  text,
});
const handoff: ThreadHandoff = {
  version: 1,
  transferId: "transfer",
  sourceEnvironmentId: EnvironmentId.make("source"),
  sourceThreadId: ThreadId.make("original"),
  sourceLabel: "Laptop",
  title: "Fix tests",
  repositoryKey: "github.com/acme/repo",
  branch: "feature",
  commitSha: "a".repeat(40),
  sourceTurnId: null,
  sourceSequence: 12,
  createdAt: "2026-10-11T00:00:00.000Z",
  items: [],
  omittedItems: 5,
  omittedAttachments: 2,
};

describe("portable handoff context", () => {
  it("keeps original constraints and recent messages intact, skipping oversized items without stopping selection", () => {
    const original = item("first", "user", "Never modify the public API.");
    const latest = item("latest", "user", "Continue fixing tests.");
    const answer = item("answer", "assistant", "Two tests still fail.");
    const items = [original, item("huge", "assistant", "x".repeat(20_000)), latest, answer];
    expect(selectHandoffItems(items, 1_000)).toEqual([original, latest, answer]);
    expect(items[1]?.text.length).toBe(20_000);
  });
  it("accounts for UTF-8 and JSON escaping rather than assuming characters are tokens", () => {
    const items = [item("one", "user", "界".repeat(80)), item("two", "user", "\n".repeat(80))];
    const selected = selectHandoffItems(items, 300);
    expect(selected).toHaveLength(1);
    expect(new TextEncoder().encode(JSON.stringify(selected[0])).length).toBeLessThan(300);
  });
  it("reports omitted history and attachments and attributes historical text", () => {
    const text = renderHandoffContext({
      ...handoff,
      items: [item("original", "user", "Keep compatibility.")],
    });
    expect(text).toContain("Keep compatibility.");
    expect(text).toContain("not a new request");
    expect(text).toContain("5 older or oversized items were not transferred");
    expect(text).toContain("2 attachments were not transferred");
    expect(text).toContain("read_thread_handoff");
  });
  it("keeps the rendered context within its byte budget even with long metadata", () => {
    const text = renderHandoffContext({
      ...handoff,
      title: "界".repeat(500),
      repositoryKey: "r".repeat(4_000),
      items: [
        item("original", "user", "界".repeat(5_000)),
        item("latest", "user", "Keep the constraints."),
      ],
    });
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(16_000);
    expect(text).toContain("Keep the constraints.");
    expect(text).not.toContain("界".repeat(5_000));
  });
  it("marks code-only transfers instead of pretending complete history was imported", () => {
    expect(renderHandoffContext({ ...handoff, codeOnly: true })).toContain(
      "no conversation or attachments were transferred",
    );
  });
  it("recovers all of an imported long item in bounded pages, without contacting the source", () => {
    const imported = { ...handoff, items: [item("long", "assistant", "abc".repeat(7_000))] };
    const pieces: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = readHandoffPage(imported, { itemId: "long", textOffset: offset });
      if (!("item" in page)) throw new Error("Expected item page");
      expect(page.item.text.length).toBeLessThanOrEqual(8_000);
      pieces.push(page.item.text);
      offset = page.nextTextOffset;
    }
    expect(pieces.join("")).toBe(imported.items[0]?.text);
    expect(() => readHandoffPage(imported, { itemId: "not-imported" })).toThrow();
  });
  it("lists bounded item metadata without transmitting every item body", () => {
    const imported = {
      ...handoff,
      items: Array.from({ length: 12 }, (_, index) =>
        item(String(index), "assistant", "x".repeat(10_000)),
      ),
    };
    const page = readHandoffPage(imported, {});
    expect(page).toMatchObject({ nextOffset: 10, omittedItems: 5 });
    if (!("items" in page)) throw new Error("Expected index page");
    expect(page.items).toHaveLength(10);
    expect(page.items[0]).not.toHaveProperty("text");
  });
  it("removes environment-local context links from portable prose", () => {
    expect(portableHandoffText("  Continue the work.  ")).toBe("Continue the work.");
  });
});
