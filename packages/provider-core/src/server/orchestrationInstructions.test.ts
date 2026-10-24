import { assert, describe, it } from "@effect/vitest";

import {
  PAPERPLANE_ORCHESTRATION_INSTRUCTIONS,
  paperplaneAcpPromptWithInstructions,
  paperplaneOrchestrationPromptForFirstRun,
  paperplaneOrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("Paperplane orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(PAPERPLANE_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(
      PAPERPLANE_ORCHESTRATION_INSTRUCTIONS,
      "ordinary top-level Paperplane conversations",
    );
    assert.include(PAPERPLANE_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(PAPERPLANE_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(PAPERPLANE_ORCHESTRATION_INSTRUCTIONS, "call `delegate_task` again");
    assert.include(
      PAPERPLANE_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `paperplane_thread_send` on `childThreadId`",
    );
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(PAPERPLANE_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(PAPERPLANE_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(PAPERPLANE_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = paperplaneOrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasPaperplaneMcp: true,
    });

    assert.include(injected, "<paperplane_code_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      paperplaneOrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasPaperplaneMcp: true }),
      prompt,
    );
    assert.equal(
      paperplaneOrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasPaperplaneMcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the Paperplane MCP server is attached", () => {
    assert.equal(paperplaneOrchestrationSystemPrompt(false), undefined);
    assert.equal(paperplaneOrchestrationSystemPrompt(true), PAPERPLANE_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = paperplaneAcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasPaperplaneMcp: true },
    });

    assert.include(injected, "Paperplane interaction mode: Default");
    assert.include(injected, "Paperplane collaborative browser");
    assert.include(injected, "Paperplane orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasPaperplaneMcp: true } as const;

    assert.equal(
      paperplaneAcpPromptWithInstructions({
        prompt,
        state: defaultState,
        previousState: defaultState,
      }),
      prompt,
    );
    assert.include(
      paperplaneAcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "Paperplane interaction mode: Plan",
    );
    const withoutMcp = paperplaneAcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasPaperplaneMcp: false },
    });
    assert.include(withoutMcp, "Paperplane interaction mode: Default");
    assert.notInclude(withoutMcp, "Paperplane collaborative browser");
    assert.notInclude(withoutMcp, "Paperplane orchestration");
  });
});
