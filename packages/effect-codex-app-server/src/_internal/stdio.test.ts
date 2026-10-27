import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";

import * as CodexError from "../errors.ts";
import { makeTerminationError } from "./stdio.ts";

describe("Codex App Server child process termination", () => {
  it.effect("retains the process identifier with the exit code", () =>
    Effect.gen(function* () {
      const error = yield* makeTerminationError({
        pid: ChildProcessSpawner.ProcessId(51),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(9)),
      });

      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.equal(error.pid, 51);
      assert.equal(error.code, 9);
      assert.equal(error.message, "Codex App Server process exited with code 9");
    }),
  );

  it.effect("reports SIGKILL as a process exit with its signal and identifier", () =>
    Effect.gen(function* () {
      const error = yield* makeTerminationError({
        pid: ChildProcessSpawner.ProcessId(53),
        exitCode: Effect.fail(
          PlatformError.systemError({
            _tag: "Unknown",
            module: "ChildProcess",
            method: "exitCode",
            description: "Process interrupted due to receipt of signal: 'SIGKILL'",
          }),
        ),
      });

      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.equal(error.pid, 53);
      assert.equal(error.signal, "SIGKILL");
      assert.isUndefined(error.code);
      assert.equal(error.message, "Codex App Server process was killed by SIGKILL");
    }),
  );

  it.effect("recognizes the nested signal error emitted by the Node spawner", () =>
    Effect.gen(function* () {
      const error = yield* makeTerminationError({
        pid: ChildProcessSpawner.ProcessId(54),
        exitCode: Effect.fail(
          PlatformError.systemError({
            _tag: "Unknown",
            module: "ChildProcess",
            method: "exitCode",
            cause: new Error("Process interrupted due to receipt of signal: 'SIGKILL'"),
          }),
        ),
      });
      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.equal(error.signal, "SIGKILL");
      assert.equal(error.pid, 54);
    }),
  );

  it.effect("retains the process identifier and exact exit-status cause", () =>
    Effect.gen(function* () {
      const rootCause = new Error("private process diagnostics");
      const cause = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "exitCode",
        cause: rootCause,
      });
      const error = yield* makeTerminationError({
        pid: ChildProcessSpawner.ProcessId(52),
        exitCode: Effect.fail(cause),
      });

      assert.instanceOf(error, CodexError.CodexAppServerTransportError);
      assert.equal(error.pid, 52);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Codex App Server transport operation 'read-process-exit-status' failed.",
      );
      assert.notInclude(error.message, rootCause.message);
    }),
  );
});
