import { assert, describe, it } from "@effect/vitest";

import {
  ROVE_CODE_ORCHESTRATION_INSTRUCTIONS,
  roveAcpPromptWithInstructions,
  roveOrchestrationPromptForFirstRun,
  roveOrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("Paperplane orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(ROVE_CODE_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(
      ROVE_CODE_ORCHESTRATION_INSTRUCTIONS,
      "ordinary top-level Paperplane conversations",
    );
    assert.include(ROVE_CODE_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(ROVE_CODE_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(ROVE_CODE_ORCHESTRATION_INSTRUCTIONS, "call `delegate_task` again");
    assert.include(
      ROVE_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `rove_thread_send` on `childThreadId`",
    );
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(ROVE_CODE_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(ROVE_CODE_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(ROVE_CODE_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = roveOrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasRoveMcp: true,
    });

    assert.include(injected, "<rove_code_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      roveOrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasRoveMcp: true }),
      prompt,
    );
    assert.equal(
      roveOrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasRoveMcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the Paperplane MCP server is attached", () => {
    assert.equal(roveOrchestrationSystemPrompt(false), undefined);
    assert.equal(roveOrchestrationSystemPrompt(true), ROVE_CODE_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = roveAcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasRoveMcp: true },
    });

    assert.include(injected, "Paperplane interaction mode: Default");
    assert.include(injected, "Paperplane collaborative browser");
    assert.include(injected, "Paperplane orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasRoveMcp: true } as const;

    assert.equal(
      roveAcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      roveAcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "Paperplane interaction mode: Plan",
    );
    const withoutMcp = roveAcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasRoveMcp: false },
    });
    assert.include(withoutMcp, "Paperplane interaction mode: Default");
    assert.notInclude(withoutMcp, "Paperplane collaborative browser");
    assert.notInclude(withoutMcp, "Paperplane orchestration");
  });
});
