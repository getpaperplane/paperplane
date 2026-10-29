import {
  CommandId,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ThreadId,
  TurnItemId,
} from "@getpaperplane/contracts";
import * as KeyedLock from "@getpaperplane/shared/KeyedLock";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Orchestrator from "./Orchestrator.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";

export class BackgroundCommandError extends Schema.TaggedError<BackgroundCommandError>()(
  "BackgroundCommandError",
  {
    reason: Schema.Literals(["not_found", "dispatch", "process"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_found":
        return "No Paperplane background command belongs to this thread and item.";
      case "dispatch":
        return "The background command request could not be recorded.";
      case "process":
        return "The background command process could not be controlled.";
    }
  }
}

export class BackgroundCommandService extends Context.Service<
  BackgroundCommandService,
  {
    readonly shutdown: Effect.Effect<void, BackgroundCommandError>;
    readonly start: (input: {
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly clientRequestId: string;
      readonly command: string;
      readonly title?: string | undefined;
    }) => Effect.Effect<TurnItemId, BackgroundCommandError>;
    readonly status: (input: {
      readonly threadId: ThreadId;
      readonly itemId: TurnItemId;
    }) => Effect.Effect<
      Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
      BackgroundCommandError
    >;
    readonly stop: (input: {
      readonly threadId: ThreadId;
      readonly itemId: TurnItemId;
      readonly clientRequestId?: string | undefined;
    }) => Effect.Effect<void, BackgroundCommandError>;
    readonly launch: (input: {
      readonly threadId: ThreadId;
      readonly itemId: TurnItemId;
    }) => Effect.Effect<void, BackgroundCommandError>;
    readonly terminate: (input: {
      readonly threadId: ThreadId;
      readonly itemId?: TurnItemId;
    }) => Effect.Effect<void, BackgroundCommandError>;
  }
>()("@getpaperplane/server/orchestration-v2/BackgroundCommandService") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const hub = yield* CommandOutputHub.CommandOutputHub;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const observationScope = yield* Scope.make();
  const generation = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
  const locks = yield* KeyedLock.make<string>();
  let shuttingDown = false;
  const running = new Map<
    TurnItemId,
    {
      readonly threadId: ThreadId;
      readonly child: ChildProcessSpawner.ChildProcessHandle;
      output: string;
      stopping: boolean;
      readonly settled: Deferred.Deferred<void>;
    }
  >();
  const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
    engine
      .dispatch(command)
      .pipe(Effect.mapError((cause) => new BackgroundCommandError({ reason: "dispatch", cause })));
  const status = Effect.fn("BackgroundCommandService.status")(function* (input: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) {
    const item = yield* engine
      .getTurnItem(input)
      .pipe(Effect.mapError((cause) => new BackgroundCommandError({ reason: "dispatch", cause })));
    if (item?.type !== "command_execution" || item.execution?.owner !== "paperplane")
      return yield* new BackgroundCommandError({ reason: "not_found" });
    const entry = running.get(input.itemId);
    return entry !== undefined && entry.threadId === input.threadId
      ? { ...item, output: entry.output }
      : item;
  });
  const observed = Effect.fn("BackgroundCommandService.observed")(function* (
    input: { readonly threadId: ThreadId; readonly itemId: TurnItemId },
    result: {
      readonly status: "running" | "completed" | "failed" | "interrupted";
      readonly output?: string;
      readonly exitCode?: number | undefined;
    },
  ) {
    const item = yield* status(input);
    if (item.execution === undefined) return;
    yield* dispatch({
      type: "background-command.observed",
      commandId: CommandId.make(
        `background-observed:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
      ),
      ...input,
      generation: item.execution.generation,
      ...result,
    });
    if (result.status !== "running") yield* hub.finish(input);
  });
  const terminate = Effect.fn("BackgroundCommandService.terminate")(function* (input: {
    readonly threadId: ThreadId;
    readonly itemId?: TurnItemId;
  }) {
    const ids =
      input.itemId === undefined
        ? [...running].filter(([, entry]) => entry.threadId === input.threadId).map(([id]) => id)
        : [input.itemId];
    for (const itemId of ids) {
      yield* locks.withLock(
        itemId,
        Effect.gen(function* () {
          const target = { threadId: input.threadId, itemId };
          const item = yield* status(target);
          const entry = running.get(itemId);
          if (entry !== undefined && entry.threadId === input.threadId) {
            entry.stopping = true;
            yield* entry.child
              .kill({ forceKillAfter: "2 seconds" })
              .pipe(
                Effect.mapError(
                  (cause) => new BackgroundCommandError({ reason: "process", cause }),
                ),
              );
            yield* Deferred.await(entry.settled);
            const code = yield* entry.child.exitCode.pipe(Effect.option);
            yield* observed(target, {
              status: "interrupted",
              output: entry.output,
              exitCode: Option.getOrUndefined(code),
            });
          } else if (item.status === "pending" && item.execution?.stopRequested) {
            // Durable cancellation won before launch; no child was ever created.
            yield* observed(target, { status: "interrupted", output: "Stopped before launch." });
          }
        }),
      );
    }
  });
  const launch = Effect.fn("BackgroundCommandService.launch")(function* (input: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) {
    yield* locks
      .withLock(
        "launch-capacity",
        locks.withLock(
          input.itemId,
          Effect.gen(function* () {
            const item = yield* status(input);
            if (running.has(item.id) || !["pending", "running"].includes(item.status)) return;
            const thread = yield* engine
              .getThreadShell(input.threadId)
              .pipe(
                Effect.mapError(
                  (cause) => new BackgroundCommandError({ reason: "dispatch", cause }),
                ),
              );
            if (shuttingDown || thread === null || thread.deletedAt !== null) {
              yield* observed(input, {
                status: "interrupted",
                output: "The thread or server stopped before launch.",
              });
              return;
            }
            if (item.execution?.generation !== generation) {
              yield* observed(input, {
                status: "interrupted",
                output:
                  "Server process ownership was lost. The command was not relaunched; an orphan process may still need manual cleanup.",
              });
              return;
            }
            if (item.execution.stopRequested) {
              yield* observed(input, { status: "interrupted", output: "Stopped before launch." });
              return;
            }
            if (running.size >= 64) {
              yield* observed(input, {
                status: "failed",
                output: "The server background command limit (64) was reached.",
              });
              return;
            }
            if (item.status === "running") {
              yield* observed(input, {
                status: "interrupted",
                output:
                  "The launch was already claimed but its process handle is unavailable. The command was not relaunched.",
              });
              return;
            }
            // Claim durably before spawn: even a failed final observation cannot cause a retry to spawn twice.
            yield* observed(input, { status: "running" });
            if ((yield* status(input)).execution?.stopRequested) {
              yield* observed(input, { status: "interrupted", output: "Stopped before launch." });
              return;
            }
            const processScope = yield* Scope.make();
            const spawn = yield* Effect.exit(
              spawner
                .spawn(
                  ChildProcess.make(item.input, [], {
                    shell: true,
                    cwd: item.execution.cwd,
                    stdin: "ignore",
                    stdout: "pipe",
                    stderr: "pipe",
                    forceKillAfter: "2 seconds",
                  }),
                )
                .pipe(Effect.provideService(Scope.Scope, processScope)),
            );
            if (Exit.isFailure(spawn)) {
              yield* Scope.close(processScope, Exit.void);
              yield* observed(input, {
                status: "failed",
                output: "The background command could not be launched.",
              });
              return;
            }
            const entry = {
              settled: yield* Deferred.make<void>(),
              stopping: false,
              threadId: input.threadId,
              child: spawn.value,
              output: "",
            };
            running.set(item.id, entry);
            yield* Effect.gen(function* () {
              const result = yield* Effect.exit(
                Effect.all(
                  [
                    Effect.exit(entry.child.exitCode),
                    entry.child.all.pipe(
                      Stream.decodeText(),
                      Stream.runForEach((chunk) => {
                        entry.output = (entry.output + chunk).slice(-32768);
                        return hub.append({ ...input, chunk });
                      }),
                    ),
                  ],
                  { concurrency: "unbounded" },
                ),
              );
              if (Exit.isSuccess(result)) {
                const current = yield* status(input);
                yield* observed(input, {
                  status:
                    entry.stopping || current.execution?.stopRequested
                      ? "interrupted"
                      : Exit.isSuccess(result.value[0]) && result.value[0].value === 0
                        ? "completed"
                        : "failed",
                  output: entry.output,
                  exitCode: Exit.isSuccess(result.value[0]) ? result.value[0].value : undefined,
                });
              } else {
                yield* entry.child
                  .kill({ forceKillAfter: "2 seconds" })
                  .pipe(
                    Effect.mapError(
                      (cause) => new BackgroundCommandError({ reason: "process", cause }),
                    ),
                  );
                yield* Effect.exit(entry.child.exitCode);
                yield* observed(input, {
                  status: "failed",
                  output: entry.output + "\nBackground command output could not be read.",
                });
              }
            }).pipe(
              Effect.ensuring(Scope.close(processScope, Exit.void)),
              Effect.ensuring(Effect.sync(() => running.delete(item.id))),
              Effect.ensuring(Deferred.succeed(entry.settled, undefined)),
              Effect.catchCause((cause) =>
                Effect.logWarning("Background command observation failed", {
                  itemId: item.id,
                  cause,
                }),
              ),
              Effect.interruptible,
              Effect.forkIn(observationScope),
            );
          }),
        ),
      )
      .pipe(Effect.uninterruptible);
  });
  const shutdown = locks.withLock(
    "launch-capacity",
    Effect.gen(function* () {
      shuttingDown = true;
      const results = yield* Effect.forEach(
        [...running],
        ([itemId, entry]) => Effect.exit(terminate({ threadId: entry.threadId, itemId })),
        { concurrency: 8 },
      );
      yield* Scope.close(observationScope, Exit.void);
      yield* Exit.asVoidAll(results);
    }),
  );
  yield* Effect.addFinalizer(() =>
    shutdown.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Background command shutdown failed", { cause }),
      ),
    ),
  );
  return BackgroundCommandService.of({
    shutdown,
    status,
    launch,
    terminate,
    start: Effect.fn("BackgroundCommandService.start")(function* (input) {
      const bytes = yield* crypto
        .digest(
          "SHA-256",
          new TextEncoder().encode(
            `${input.threadId.length}:${input.threadId}${input.clientRequestId}`,
          ),
        )
        .pipe(Effect.orDie);
      const digest = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const itemId = TurnItemId.make(`background:${digest}`);
      yield* dispatch({
        type: "background-command.start",
        ...input,
        itemId,
        generation,
        commandId: CommandId.make(`background-start:${digest}`),
      });
      return itemId;
    }),
    stop: Effect.fn("BackgroundCommandService.stop")(function* (input) {
      yield* status(input);
      yield* dispatch({
        type: "background-command.stop",
        threadId: input.threadId,
        itemId: input.itemId,
        commandId: CommandId.make(
          `background-stop:${input.threadId}:${input.itemId}:${input.clientRequestId ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie))}`,
        ),
      });
    }),
  });
});

export const layer = Layer.effect(BackgroundCommandService, make);
