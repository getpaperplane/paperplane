// @effect-diagnostics nodeBuiltinImport:off -- flock owns the cross-process setup lease.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import { nextSliceLimits, type SliceLimits } from "./roveMemoryBudget.ts";

class SystemdSliceError extends Schema.TaggedError<SystemdSliceError>()("SystemdSliceError", {
  exitCode: Schema.NullOr(Schema.Number),
}) {
  override get message() {
    return "Could not configure Paperplane's systemd slice.";
  }
}

/** Hold an OS lock while TypeScript reads and updates systemd properties. */
export function withSliceLock<A, E, R>(
  runtimeDir: string,
  unit: string,
  body: Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.tryPromise(
      () =>
        new Promise<() => Promise<void>>((resolve, reject) => {
          const holder = NodeChildProcess.spawn(
            "flock",
            [
              "--exclusive",
              "--close",
              NodePath.join(runtimeDir, `${unit}.lock`),
              "sh",
              "-c",
              "printf 'ready\\n'; read -r release",
            ],
            { stdio: ["pipe", "pipe", "pipe"] },
          );
          const exited = new Promise<void>((done) => holder.once("close", () => done()));
          holder.once("error", reject);
          holder.once("exit", (code) => reject(new Error(`Slice lock exited (${code}).`)));
          holder.stdout.once("data", () =>
            resolve(async () => {
              holder.stdin.end("release\n");
              await exited;
            }),
          );
          holder.stderr.resume();
        }),
    ),
    () => body,
    (release) => Effect.promise(release),
  );
}

const runSystemctl = Effect.fn("runSystemctl")(function* (args: ReadonlyArray<string>) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner.run({
    command: "systemctl",
    args: ["--user", ...args],
    timeout: "5 seconds",
  });
  if (result.code !== 0) return yield* new SystemdSliceError({ exitCode: result.code });
  return result.stdout.trim();
});

export const configureSlice = Effect.fn("configureSlice")(function* (
  unit: string,
  requested: SliceLimits,
  properties: ReadonlyArray<string> = [],
) {
  const fs = yield* FileSystem.FileSystem;
  yield* runSystemctl(["start", unit]);
  const shown = yield* runSystemctl(["show", unit, "--property=MemoryMax,ControlGroup"]);
  const values = new Map(
    shown.split("\n").map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)] as const;
    }),
  );
  const limit = (key: string) => {
    const value = values.get(key);
    return value === undefined || value === "infinity" ? Infinity : Number(value);
  };
  const cgroup = values.get("ControlGroup");
  const read = (name: string) =>
    cgroup
      ? fs
          .readFileString(NodePath.join("/sys/fs/cgroup", cgroup, name))
          .pipe(Effect.orElseSucceed(() => ""))
      : Effect.succeed("");
  const events = yield* read("cgroup.events");
  const usage = yield* read("memory.current");
  const next = nextSliceLimits({
    current: { max: limit("MemoryMax") },
    requested,
    // Unknown state must not permit an unsafe shrink.
    populated: !/^populated 0$/m.test(events),
    memoryCurrent: usage.trim() === "" ? Infinity : Number(usage),
  });
  if (next.deferred)
    yield* Effect.logWarning("Paperplane slice memory ceiling reduction deferred until usage falls", {
      unit,
      requestedMax: requested.max,
      retainedMax: next.max,
    });
  const format = (value: number) => (Number.isFinite(value) ? String(value) : "infinity");
  yield* runSystemctl([
    "set-property",
    "--runtime",
    unit,
    // Clear soft limits from earlier builds: throttling can stall a runaway below Max.
    "MemoryHigh=infinity",
    `MemoryMax=${format(next.max)}`,
    ...properties,
  ]);
  return { max: next.max };
});
