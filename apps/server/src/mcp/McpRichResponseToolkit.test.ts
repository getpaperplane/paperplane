import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { splitRichResponse } from "@rove-code/shared/richResponse";
import {
  RichResponseToolkit,
  RichResponseToolkitHandlersLive,
} from "./toolkits/richResponse/tools.ts";

const decodePreparedResponse = Schema.decodeUnknownEffect(
  Schema.Struct({ responseMarkdown: Schema.String }),
);
const TestLayer = McpServer.toolkit(RichResponseToolkit).pipe(
  Layer.provide(RichResponseToolkitHandlersLive),
  Layer.provideMerge(McpServer.McpServer.layer),
);
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "rich-response-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "rich-response-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("prepares a validated response without publishing or calling a provider", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const tool = server.tools.find(({ tool }) => tool.name === "prepare_rich_response");
    expect(tool?.tool.annotations?.readOnlyHint).toBe(true);
    const response = {
      version: 1,
      blocks: [{ type: "details", title: "More detail", text: "A local fixture." }],
    };
    const result = yield* server.callTool({ name: "prepare_rich_response", arguments: response });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      responseMarkdown: expect.stringContaining("```rove-response"),
    });
    const content = yield* decodePreparedResponse(result.structuredContent);
    expect(splitRichResponse(content.responseMarkdown)[0]).toMatchObject({
      kind: "rich-response",
      response,
    });
  }).pipe(Effect.provideService(McpSchema.McpServerClient, client), Effect.provide(TestLayer)),
);

it.effect("rejects executable blocks and malformed tables at the tool boundary", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const blocks of [
      [{ type: "html", html: "<script>alert(1)</script>" }],
      [{ type: "text", text: "Hi", onClick: "execute" }],
      [{ type: "table", title: "Bad", columns: ["A", "B"], rows: [["Only one"]] }],
    ]) {
      const result = yield* server.callTool({
        name: "prepare_rich_response",
        arguments: { version: 1, blocks },
      });
      expect(result.isError).toBe(true);
    }
  }).pipe(Effect.provideService(McpSchema.McpServerClient, client), Effect.provide(TestLayer)),
);
