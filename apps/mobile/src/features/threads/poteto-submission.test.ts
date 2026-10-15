import { EnvironmentId, ProviderInstanceId, ThreadId } from "@rove-code/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createPotetoThreadTarget,
  requirePotetoCommandSuccess,
  startReviewedPoteto,
} from "./poteto-submission";

const modelSelection = { instanceId: ProviderInstanceId.make("pi"), model: "openai/gpt-5.4" };
const accepted = AsyncResult.success({ sequence: 1 });

it("shares thread creation while pending and after drafting, but allows a failed creation to retry", async () => {
  const created = Promise.withResolvers<ThreadId>();
  const create = vi.fn(() => created.promise);
  const getThreadId = createPotetoThreadTarget(create);
  const first = getThreadId();
  const replay = getThreadId();
  expect(replay).toBe(first);
  expect(create).toHaveBeenCalledTimes(1);
  created.resolve(ThreadId.make("new-task"));
  await expect(first).resolves.toBe("new-task");
  await expect(getThreadId()).resolves.toBe("new-task");
  expect(create).toHaveBeenCalledTimes(1);

  const retryCreate = vi
    .fn<() => Promise<ThreadId>>()
    .mockRejectedValueOnce(new Error("Disconnected"))
    .mockResolvedValue(ThreadId.make("same-target"));
  const retry = createPotetoThreadTarget(retryCreate);
  await expect(retry()).rejects.toThrow("Disconnected");
  await expect(retry()).resolves.toBe("same-target");
});

it("waits for the reviewed model to be persisted before starting and consuming the unchanged prompt", async () => {
  const prepared = Promise.withResolvers<typeof accepted>();
  const started = Promise.withResolvers<typeof accepted>();
  const startEntered = Promise.withResolvers<void>();
  const environmentId = EnvironmentId.make("reviewed-host");
  const threadId = ThreadId.make("reviewed-thread");
  let prompt = "Fix truncate";
  let persistedModel = { ...modelSelection, model: "old-model" };
  const runs: Array<{ environmentId: EnvironmentId; threadId: ThreadId; model: string }> = [];
  const pending = startReviewedPoteto({
    modelSelection,
    description: prompt,
    prepare: async (model) => {
      const result = await prepared.promise;
      persistedModel = model;
      return result;
    },
    start: async () => {
      runs.push({ environmentId, threadId, model: persistedModel.model });
      startEntered.resolve();
      return started.promise;
    },
    readPrompt: () => prompt,
    clearPrompt: () => {
      prompt = "";
    },
  });
  expect(runs).toEqual([]);
  expect(prompt).toBe("Fix truncate");
  prepared.resolve(accepted);
  await startEntered.promise;
  expect(runs).toEqual([{ environmentId, threadId, model: modelSelection.model }]);
  expect(prompt).toBe("Fix truncate");
  started.resolve(accepted);
  await pending;
  expect(prompt).toBe("");
});

it("keeps a newer composer edit when the approved run succeeds", async () => {
  const started = Promise.withResolvers<typeof accepted>();
  const startEntered = Promise.withResolvers<void>();
  let prompt = "Fix truncate";
  const pending = startReviewedPoteto({
    modelSelection,
    description: prompt,
    prepare: async () => accepted,
    start: () => {
      startEntered.resolve();
      return started.promise;
    },
    readPrompt: () => prompt,
    clearPrompt: () => {
      prompt = "";
    },
  });
  await startEntered.promise;
  prompt = "Fix truncate with a smaller limit";
  started.resolve(accepted);
  await pending;
  expect(prompt).toBe("Fix truncate with a smaller limit");
});

describe.each([
  [
    "rejected",
    AsyncResult.failure<{ readonly sequence: number }, Error>(
      Cause.fail(new Error("Request rejected")),
    ),
  ],
  ["interrupted", AsyncResult.failure<{ readonly sequence: number }, never>(Cause.interrupt(1))],
] as const)("%s commands", (_name, failure) => {
  it("does not start or consume the draft when model preparation fails", async () => {
    const start = vi.fn(async () => accepted);
    const clearPrompt = vi.fn();
    await expect(
      startReviewedPoteto({
        modelSelection,
        description: "Fix truncate",
        prepare: async () => failure,
        start,
        readPrompt: () => "Fix truncate",
        clearPrompt,
      }),
    ).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
    expect(clearPrompt).not.toHaveBeenCalled();
  });

  it("keeps the draft when start fails", async () => {
    let prompt = "Fix truncate";
    await expect(
      startReviewedPoteto({
        modelSelection,
        description: prompt,
        prepare: async () => accepted,
        start: async () => failure,
        readPrompt: () => prompt,
        clearPrompt: () => {
          prompt = "";
        },
      }),
    ).rejects.toThrow();
    expect(prompt).toBe("Fix truncate");
  });
});

it("reports interruption instead of treating it as successful creation", () => {
  expect(() => requirePotetoCommandSuccess(AsyncResult.failure(Cause.interrupt(1)))).toThrow(
    "interrupted",
  );
});
