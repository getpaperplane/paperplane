import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@rove-code/contracts";
import { splitRichResponse } from "@rove-code/shared/richResponse";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import {
  RichResponseToolkit,
  RichResponseToolkitHandlersLive,
} from "./toolkits/richResponse/tools.ts";

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "html-render-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "html-render-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const invocation = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) => ({
  environmentId: EnvironmentId.make("environment-html-render-test"),
  threadId: ThreadId.make("thread-html-render-test"),
  providerSessionId: "provider-session-html-render-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const testLayer = (enableRichResponses: boolean) =>
  McpServer.toolkit(RichResponseToolkit).pipe(
    Layer.provide(RichResponseToolkitHandlersLive),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(ServerSettings.layerTest({ enableRichResponses })),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "rove-mcp-html-render-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const callRender = (
  html: string,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["rich-responses"],
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "html_render", arguments: { html, title: "Memory budget" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("stores a themed page with local media embedded and returns its reference", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const imagePath = path.join(config.baseDir, "chart.png");
    yield* fileSystem.writeFile(imagePath, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const missingPath = path.join(config.baseDir, "gone.mp4");

    const result = yield* callRender(
      `<!doctype html><html><head><title>t</title></head><body><img src="${imagePath}"><video src="file://${missingPath}"></video></body></html>`,
    );
    expect(result.isError).not.toBe(true);
    const content = result.structuredContent as {
      responseMarkdown: string;
      missingFiles?: string[];
    };
    expect(content.missingFiles).toEqual([missingPath]);
    const [segment] = splitRichResponse(content.responseMarkdown);
    expect(segment?.kind).toBe("rich-response");
    const block = segment?.kind === "rich-response" ? segment.response.blocks[0] : undefined;
    expect(block).toMatchObject({ type: "html", title: "Memory budget", height: 360 });

    const attachmentId = block?.type === "html" ? block.attachmentId : "";
    const stored = yield* fileSystem.readFileString(
      path.join(config.attachmentsDir, `${attachmentId}.html`),
    );
    expect(stored).toContain('id="rove-theme"');
    expect(stored).toContain('src="data:image/png;base64,iVBORw=="');
    expect(stored).not.toContain(imagePath);
    expect(stored).toContain(missingPath);
  }).pipe(Effect.provide(testLayer(true))),
);

it.effect("refuses when the session lacks the capability", () =>
  Effect.gen(function* () {
    const result = yield* callRender("<p>Hi</p>", []);
    expect(result.isError).toBe(true);
  }).pipe(Effect.provide(testLayer(true))),
);

it.effect("refuses once rich responses are turned off, even for an older session", () =>
  Effect.gen(function* () {
    const result = yield* callRender("<p>Hi</p>");
    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining("Answer in Markdown") }),
    );
  }).pipe(Effect.provide(testLayer(false))),
);
