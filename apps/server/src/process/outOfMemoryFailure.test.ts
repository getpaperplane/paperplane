import { describe, expect, it } from "@effect/vitest";
import { makeProviderFailure } from "@rove-code/provider-core/server/failure";

import { labelOutOfMemory } from "./outOfMemoryFailure.ts";

const failure = makeProviderFailure({
  class: "provider_error",
  message: "Provider process exited",
  code: "process_exit",
  retryable: true,
});

describe("labelOutOfMemory", () => {
  it("keeps the original failure when there is no memory verdict", () => {
    expect(labelOutOfMemory(failure, null)).toBe(failure);
  });

  it("labels confirmed memory kills", () => {
    expect(labelOutOfMemory(failure, "confirmed")).toEqual({
      ...failure,
      message: "Killed: out of memory.",
      code: "oom_kill",
    });
    expect(failure.code).toBe("process_exit");
  });

  it.each([
    ["AcpProcessExitedError", { signal: "SIGKILL" }],
    ["CodexAppServerProcessExitedError", { code: 137 }],
  ])("labels likely memory kills with typed %s evidence", (_tag, evidence) => {
    const killed = makeProviderFailure({
      message: failure.message,
      class: failure.class,
      code: failure.code,
      cause: { cause: { _tag, ...evidence } },
    });
    expect(labelOutOfMemory(killed, "likely")).toEqual({
      ...killed,
      message:
        'Likely killed: the host ran out of memory. Run fewer agents at once or add swap (see "Small or WSL hosts" in the Paperplane docs).',
      code: "oom_kill",
    });
  });

  it("does not relabel exit code 1 or missing kill evidence despite a risen host counter", () => {
    const exited = makeProviderFailure({
      message: failure.message,
      class: failure.class,
      code: failure.code,
      cause: { _tag: "AcpProcessExitedError", code: 1 },
    });
    expect(labelOutOfMemory(exited, "likely")).toBe(exited);
    expect(labelOutOfMemory(failure, "likely")).toBe(failure);
    expect(labelOutOfMemory(exited, "confirmed").message).toBe("Killed: out of memory.");
  });

  it.each(["confirmed", "likely", null] as const)("preserves usage limits for %s", (verdict) => {
    const usageLimit = makeProviderFailure({
      class: "usage_limit",
      message: "Usage limit reached",
      code: "rate_limit",
      retryable: false,
    });
    expect(labelOutOfMemory(usageLimit, verdict)).toBe(usageLimit);
  });
});
