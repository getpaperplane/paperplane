import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ChildProcessSpawner } from "effect/process";
import * as ProcessRunner from "../processRunner.ts";
import { configureSlice } from "./systemdSlice.ts";

const configured = (current: number, usage: number, populated: boolean, requested: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const calls: ReadonlyArray<string>[] = [];
    const runner = ProcessRunner.ProcessRunner.of({
      run: ({ args }) =>
        Effect.sync(() => {
          calls.push(args);
          return {
            stdout: args.includes("show")
              ? `MemoryHigh=${current}\nMemoryMax=${current}\nControlGroup=/test.slice`
              : "",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    const result = yield* configureSlice("test.slice", {
      max: requested,
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readFileString: (path) =>
          Effect.succeed(
            path.endsWith("cgroup.events") ? `populated ${populated ? 1 : 0}` : String(usage),
          ),
      }),
    );
    return { result, properties: calls.find((args) => args.includes("set-property")) };
  }).pipe(Effect.provide(NodeServices.layer));

describe("systemd slice live setup", () => {
  it.effect("clears a previous soft limit but retains an unsafe hard ceiling", () =>
    Effect.gen(function* () {
      const { result, properties } = yield* configured(2000, 1500, true, 1000);
      expect(result).toEqual({ max: 2000 });
      expect(properties).toContain("MemoryHigh=infinity");
      expect(properties).toContain("MemoryMax=2000");
    }),
  );
  it.effect("lowers an empty slice or a live slice below the requested limit", () =>
    Effect.gen(function* () {
      expect((yield* configured(2000, 1500, false, 1000)).result.max).toBe(1000);
      expect((yield* configured(2000, 999, true, 1000)).result.max).toBe(1000);
    }),
  );
  it.effect("always raises and can clear limits", () =>
    Effect.gen(function* () {
      expect((yield* configured(1000, 1500, true, 2000)).result.max).toBe(2000);
      const cleared = yield* configured(1000, 1500, true, Infinity);
      expect(cleared.properties).toContain("MemoryMax=infinity");
      expect(cleared.properties).toContain("MemoryHigh=infinity");
    }),
  );
});
