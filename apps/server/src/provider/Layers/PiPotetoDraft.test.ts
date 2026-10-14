// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vite-plus/test";
import { runPiPotetoDraft } from "./PiPotetoDraft.ts";

it("dispatches only snapshot/draft capabilities in an extension-free real SDK session", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "rove-draft-sdk-"));
  vi.stubEnv("PI_OFFLINE", "1");
  try {
    await NodeFSP.mkdir(NodePath.join(root, ".pi", "extensions"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(root, ".pi", "extensions", "poison.ts"),
      'throw new Error("POISON extension ran");',
    );
    await NodeFSP.writeFile(NodePath.join(root, "AGENTS.md"), "POISON instructions");
    const runtime = await ModelRuntime.create({
      authPath: NodePath.join(root, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const spec = {
      task: "Fix boundary",
      editableFiles: ["price.ts"],
      contextFiles: [],
      check: { module: "price.ts", export: "price", cases: [{ args: [100], expected: 10 }] },
    };
    let sawDenied = false;
    let sawUnreadDenied = false;
    let sawMalformedDenied = false;
    runtime.registerProvider("draft-fixture", {
      api: "openai-completions",
      apiKey: "fixture",
      baseUrl: "https://example.invalid",
      models: [
        {
          id: "fixture",
          name: "Fixture",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 64_000,
          maxTokens: 2048,
        },
      ],
      streamSimple(model, context) {
        const results = context.messages.filter((message) => message.role === "toolResult");
        let content: AssistantMessage["content"];
        let stopReason: "toolUse" | "stop" = "toolUse";
        if (results.length === 0)
          content = [
            {
              type: "toolCall",
              id: "outside",
              name: "read_snapshot",
              arguments: { path: "/etc/passwd" },
            },
          ];
        else if (results.length === 1) {
          sawDenied = results[0]!.isError;
          content = [
            {
              type: "toolCall",
              id: "approved",
              name: "read_snapshot",
              arguments: { path: "price.ts" },
            },
          ];
        } else if (results.length === 2)
          content = [
            {
              type: "toolCall",
              id: "malformed",
              name: "submit_draft",
              arguments: {
                result: { status: "draft", spec: { ...spec, check: { ...spec.check, cases: [] } } },
              },
            },
          ];
        else if (results.length === 3) {
          sawMalformedDenied = results[2]!.isError;
          content = [
            {
              type: "toolCall",
              id: "unread",
              name: "submit_draft",
              arguments: {
                result: { status: "draft", spec: { ...spec, contextFiles: ["context.ts"] } },
              },
            },
          ];
        } else if (results.length === 4) {
          sawUnreadDenied = results[3]!.isError;
          content = [
            {
              type: "toolCall",
              id: "draft",
              name: "submit_draft",
              arguments: { result: { status: "draft", spec } },
            },
          ];
        } else {
          content = [{ type: "text", text: "Done" }];
          stopReason = "stop";
        }
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: 0,
          content,
          stopReason,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: stopReason, message });
        stream.end();
        return stream;
      },
    });
    const result = await runPiPotetoDraft(
      {
        cwd: root,
        agentDir: root,
        model: "draft-fixture/fixture",
        modelRuntime: runtime,
        onSession: (session) => {
          expect(session.systemPrompt).not.toContain("POISON");
          expect(session.getActiveToolNames().sort()).toEqual(["read_snapshot", "submit_draft"]);
        },
      },
      {
        description: "Boundary broken in price.ts",
        files: [
          { path: "price.ts", content: "export const price = x => x > 100 ? 10 : 0;" },
          { path: "context.ts", content: "export const minimum = 100;" },
        ],
        signal: new AbortController().signal,
      },
    );
    expect(sawDenied).toBe(true);
    expect(sawUnreadDenied).toBe(true);
    expect(sawMalformedDenied).toBe(true);
    expect(result).toEqual({ status: "draft", spec });
    expect(await NodeFSP.readFile(NodePath.join(root, "AGENTS.md"), "utf8")).toBe(
      "POISON instructions",
    );
  } finally {
    vi.unstubAllEnvs();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
