import {
  applyTerminalAttachStreamEvent,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  EMPTY_TERMINAL_BUFFER_STATE,
  terminalOutputText,
} from "@getpaperplane/client-runtime/state/terminal";
import { expect, it, vi } from "vite-plus/test";

import { createTerminalOutputWriter } from "./terminalOutputWriter";

function append(
  state: typeof EMPTY_TERMINAL_BUFFER_STATE,
  data: string,
  limit = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
) {
  return applyTerminalAttachStreamEvent(
    state,
    { type: "output", data, threadId: "thread", terminalId: "term-1" },
    limit,
  );
}

it("transfers only new chunks over 2 MiB of output with full 512 KiB retention", async () => {
  const write = vi.fn(async (_data: string, _reset: boolean) => {});
  const writer = createTerminalOutputWriter(write);
  let state = EMPTY_TERMINAL_BUFFER_STATE;
  const chunks: string[] = [];
  let legacyTransferred = 0;
  await writer.write(state.output);
  for (let index = 0; index < 128; index += 1) {
    const chunk = `${index}\r\n`.padEnd(16 * 1024, "x");
    chunks.push(chunk);
    state = append(state, chunk);
    legacyTransferred += state.output.retainedBytes;
    await writer.write(state.output);
    expect(write).toHaveBeenLastCalledWith(chunk, false);
  }
  expect(state.output.retainedBytes).toBe(DEFAULT_MAX_TERMINAL_BUFFER_BYTES);
  const retained = chunks.slice(-32).join("");
  expect(terminalOutputText(state.output)).toBe(retained);
  expect(write.mock.calls.filter(([, reset]) => reset)).toEqual([["", true]]);
  expect(write.mock.calls.reduce((total, [data]) => total + data.length, 0)).toBe(2 * 1024 * 1024);
  expect(legacyTransferred).toBe(58_982_400);

  const remountedWrite = vi.fn(async () => {});
  await createTerminalOutputWriter(remountedWrite).write(state.output);
  expect(remountedWrite.mock.calls).toEqual([[retained, true]]);
});

it("recovers the newer snapshot queued during a rejected append without a third write", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const write = vi.fn(async () => {});
  const writer = createTerminalOutputWriter(write);
  const initial = append(EMPTY_TERMINAL_BUFFER_STATE, "initial");
  await writer.write(initial.output);
  write.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    throw new Error("partially applied append");
  });
  const first = append(initial, "-first");
  const draining = writer.write(first.output);
  await started.promise;
  const latest = append(first, "-latest");
  void writer.write(latest.output);
  release.resolve();
  await draining;
  expect(write.mock.calls).toEqual([
    ["initial", true],
    ["-first", false],
    ["initial-first-latest", true],
  ]);
  await writer.write(append(latest, "-next").output);
  expect(write).toHaveBeenLastCalledWith("-next", false);
});

it("preserves Unicode and ordering when snapshots coalesce during an in-flight write", async () => {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const write = vi.fn(async (_data: string, _reset: boolean) => {});
  const writer = createTerminalOutputWriter(write);
  let state = append(EMPTY_TERMINAL_BUFFER_STATE, "👩‍💻e");
  await writer.write(state.output);
  write.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
  });
  state = append(state, "\u0301\u001b[31m");
  const draining = writer.write(state.output);
  await started.promise;
  state = append(state, "中文");
  void writer.write(state.output);
  state = append(state, "\ufeff🙂\u001b[0m");
  void writer.write(state.output);
  release.resolve();
  await draining;
  expect(write.mock.calls).toEqual([
    ["👩‍💻e", true],
    ["\u0301\u001b[31m", false],
    ["中文\ufeff🙂\u001b[0m", false],
  ]);
  await writer.write(state.output);
  expect(write).toHaveBeenCalledTimes(3);
});

it("resets after clear, generation changes and a reader falling behind retention", async () => {
  const write = vi.fn(async (_data: string, _reset: boolean) => {});
  const writer = createTerminalOutputWriter(write);
  let state = append(EMPTY_TERMINAL_BUFFER_STATE, "old", 8);
  await writer.write(state.output);
  state = applyTerminalAttachStreamEvent(state, {
    type: "cleared",
    threadId: "thread",
    terminalId: "term-1",
  });
  await writer.write(state.output);
  expect(write).toHaveBeenLastCalledWith("", true);
  state = append(state, "123456789🙂", 8);
  await writer.write(state.output);
  expect(write).toHaveBeenLastCalledWith(terminalOutputText(state.output), true);
  const newGeneration = { ...state.output, generation: state.output.generation + 1 };
  await writer.write(newGeneration);
  expect(write).toHaveBeenLastCalledWith(terminalOutputText(newGeneration), true);
});

it("does not deliver queued or subsequent output after disposal", async () => {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const write = vi.fn(async () => {
    started.resolve();
    await release.promise;
  });
  const writer = createTerminalOutputWriter(write);
  const initial = append(EMPTY_TERMINAL_BUFFER_STATE, "initial");
  const draining = writer.write(initial.output);
  await started.promise;
  void writer.write(append(initial, "queued").output);
  writer.dispose();
  release.resolve();
  await draining;
  await writer.write(append(initial, "after unmount").output);
  expect(write).toHaveBeenCalledTimes(1);
});

it("settles persistent native failures after one recovery attempt", async () => {
  const failure = new Error("native unavailable");
  const write = vi.fn<(_data: string, _reset: boolean) => Promise<void>>(async () => {
    throw failure;
  });
  const writer = createTerminalOutputWriter(write);
  const state = append(EMPTY_TERMINAL_BUFFER_STATE, "output");
  await expect(writer.write(state.output)).rejects.toThrow(failure);
  expect(write).toHaveBeenCalledTimes(2);
  write.mockResolvedValue(undefined);
  await writer.write(state.output);
  expect(write).toHaveBeenLastCalledWith("output", true);
});
