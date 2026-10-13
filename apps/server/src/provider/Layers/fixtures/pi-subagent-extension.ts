import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * A scripted model for Rove subagent tests. The thread agent delegates once
 * when it has the subagent tool; the subagent answers from its own prompt.
 */
export default function (pi: ExtensionAPI) {
  pi.registerProvider("rove-subagent-test", {
    baseUrl: "https://example.invalid",
    apiKey: "test-key",
    api: "openai-completions",
    models: [
      {
        id: "fixture",
        name: "Fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 1024,
      },
    ],
    streamSimple(model, context) {
      const system = context.messages
        .filter((message) => message.role === "system")
        .map((message) => JSON.stringify(message))
        .join("\n");
      const tools = context.messages.flatMap((message) =>
        message.role === "system" ? (message.toolsAdded ?? []) : [],
      );
      const hasSubagentTool = tools.some((tool) => tool.name === "rove_subagent");
      const result = context.messages.find((message) => message.role === "toolResult");
      const reply = (content: AssistantMessage["content"], stopReason: "stop" | "toolUse") => {
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: 0,
          usage: {
            input: 3,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 5,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          content,
          stopReason,
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: stopReason, message });
        stream.end();
        return stream;
      };
      if (system.includes("<subagent>")) {
        // Subagents load no extensions, so they can never delegate again.
        const text = hasSubagentTool ? "subagent saw the subagent tool" : "child report";
        return reply([{ type: "text", text }], "stop");
      }
      if (!hasSubagentTool) return reply([{ type: "text", text: "no subagent tool" }], "stop");
      if (result) {
        const text = result.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
        return reply([{ type: "text", text: `parent got: ${text}` }], "stop");
      }
      return reply(
        [
          {
            type: "toolCall",
            id: "delegate-1",
            name: "rove_subagent",
            arguments: { description: "Inspect the repo", prompt: "inspect" },
          },
        ],
        "toolUse",
      );
    },
  });
}
