import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  latestThreadPotetoProgress,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@rove-code/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { isThreadPotetoActive, readThreadPotetoRun } from "./poteto/ThreadPotetoState.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-08-30T12:00:00.000Z";
const THREAD_ID = ThreadId.make("poteto-thread");
const SPEC = {
  task: "Fix the return value",
  editableFiles: ["src/result.ts"],
  contextFiles: [],
  check: {
    module: "src/result.ts",
    export: "result",
    cases: [{ args: [], expected: "fixed" }],
  },
};

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: THREAD_ID,
    projectId: null,
    workspacePath: "/tmp/poteto-workspace",
    title: "Poteto thread",
    modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "test/model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeReadModel(thread = makeThread()): OrchestrationReadModel {
  return { ...createEmptyReadModel(NOW), threads: [thread] };
}

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

function oneEvent(events: PlannedEvent | ReadonlyArray<PlannedEvent>) {
  return Array.isArray(events) ? events[0]! : events;
}

function applyEvents(
  initial: OrchestrationReadModel,
  events: PlannedEvent | ReadonlyArray<PlannedEvent>,
) {
  return Effect.gen(function* () {
    let readModel = initial;
    for (const event of Array.isArray(events) ? events : [events]) {
      readModel = yield* projectEvent(readModel, {
        ...event,
        sequence: readModel.snapshotSequence + 1,
      });
    }
    return readModel;
  });
}

function startCommand(commandId = CommandId.make("poteto-start")) {
  return {
    type: "thread.poteto.start" as const,
    commandId,
    threadId: THREAD_ID,
    spec: SPEC,
    createdAt: NOW,
  };
}

function appendCreatedEvent(attemptId: CommandId, commandId: CommandId) {
  return {
    type: "thread.poteto.append" as const,
    commandId,
    threadId: THREAD_ID,
    runId: CommandId.make("poteto-start"),
    attemptId,
    expectedLength: 0,
    event: {
      type: "created",
      version: "bug-fix-prototype-v2",
      task: SPEC.task,
      checkId: "check-1",
      files: [{ path: "src/result.ts", content: "export const result = () => 'old'" }],
      editablePaths: ["src/result.ts"],
    },
    createdAt: NOW,
  };
}

function asReadModelThread(readModel: OrchestrationReadModel): OrchestrationThread {
  return readModel.threads[0]!;
}

const makeActivePotetoReadModel = Effect.fnUntraced(function* (
  status: "requested" | "running" | "blocked",
) {
  let readModel = makeReadModel();
  readModel = yield* applyEvents(
    readModel,
    yield* decideOrchestrationCommand({ command: startCommand(), readModel }),
  );
  if (status === "requested") return readModel;
  const owner = CommandId.make("poteto-start");
  const commands: ReadonlyArray<OrchestrationCommand> = [
    appendCreatedEvent(owner, CommandId.make("native-stop-created")),
    {
      type: "thread.poteto.append",
      commandId: CommandId.make("native-stop-started"),
      threadId: THREAD_ID,
      runId: owner,
      attemptId: owner,
      expectedLength: 1,
      event: { type: "started", phase: "reproduce" },
      createdAt: NOW,
    },
    ...(status === "blocked"
      ? [
          {
            type: "thread.poteto.append" as const,
            commandId: CommandId.make("native-stop-blocked"),
            threadId: THREAD_ID,
            runId: owner,
            attemptId: owner,
            expectedLength: 2,
            event: { type: "blocked", phase: "reproduce", reason: "Worker interrupted" },
            createdAt: NOW,
          },
        ]
      : []),
  ];
  for (const command of commands) {
    readModel = yield* applyEvents(
      readModel,
      yield* decideOrchestrationCommand({ command, readModel }),
    );
  }
  return readModel;
});

it.layer(NodeServices.layer)("Poteto thread orchestration", (it) => {
  it.effect("start and retry wake settled or pinned threads and spend snoozes", () =>
    Effect.gen(function* () {
      for (const settledOverride of [null, "settled", "active"] as const) {
        const initial = makeReadModel(
          makeThread({
            settledOverride,
            settledAt: settledOverride === "active" ? null : NOW,
            snoozedUntil: "2026-08-31T12:00:00.000Z",
          }),
        );
        const started = yield* decideOrchestrationCommand({
          command: startCommand(),
          readModel: initial,
        });
        expect(Array.isArray(started) && started.map((event) => event.type)).toEqual([
          "thread.unsettled",
          "thread.unsnoozed",
          "thread.activity-appended",
        ]);
        const withStart = yield* applyEvents(initial, started);
        expect(asReadModelThread(withStart)).toMatchObject({
          settledOverride: null,
          settledAt: null,
          snoozedUntil: null,
        });
        expect(latestThreadPotetoProgress(asReadModelThread(withStart).activities)?.status).toBe(
          "requested",
        );
        const finished = yield* decideOrchestrationCommand({
          command: {
            type: "thread.poteto.finish",
            commandId: CommandId.make("wake-finish"),
            threadId: THREAD_ID,
            runId: CommandId.make("poteto-start"),
            attemptId: CommandId.make("poteto-start"),
            createdAt: NOW,
            progress: {
              runId: CommandId.make("poteto-start"),
              attemptId: CommandId.make("poteto-start"),
              status: "blocked",
              phase: null,
              reason: "Setup failed",
            },
          },
          readModel: withStart,
        });
        const withFinish = yield* applyEvents(withStart, finished);
        const resting = {
          ...withFinish,
          threads: [
            {
              ...asReadModelThread(withFinish),
              settledOverride,
              settledAt: settledOverride === "active" ? null : NOW,
              snoozedUntil: "2026-08-31T12:00:00.000Z",
            },
          ],
        };
        const retried = yield* decideOrchestrationCommand({
          command: {
            type: "thread.poteto.control",
            commandId: CommandId.make("wake-retry"),
            threadId: THREAD_ID,
            runId: CommandId.make("poteto-start"),
            action: "retry",
            createdAt: "2026-08-30T12:01:00.000Z",
          },
          readModel: resting,
        });
        expect(Array.isArray(retried) && retried.map((event) => event.type)).toEqual([
          "thread.unsettled",
          "thread.unsnoozed",
          "thread.activity-appended",
        ]);
        const withRetry = yield* applyEvents(resting, retried);
        expect(asReadModelThread(withRetry)).toMatchObject({
          settledOverride: null,
          settledAt: null,
          snoozedUntil: null,
        });
        expect(latestThreadPotetoProgress(asReadModelThread(withRetry).activities)).toMatchObject({
          status: "requested",
          attemptId: "wake-retry",
        });
      }
    }),
  );

  it.effect("starts only supported Pi threads with a validated, frozen selection", () =>
    Effect.gen(function* () {
      const unsupported = yield* Effect.flip(
        decideOrchestrationCommand({
          command: startCommand(),
          readModel: makeReadModel(
            makeThread({
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.4",
              },
            }),
          ),
        }),
      );
      expect(unsupported._tag).toBe("OrchestrationCommandInvariantError");

      const invalidSpec = yield* Effect.flip(
        decideOrchestrationCommand({
          command: { ...startCommand(), spec: { ...SPEC, editableFiles: ["../escape.ts"] } },
          readModel: makeReadModel(),
        }),
      );
      expect(invalidSpec._tag).toBe("OrchestrationCommandInvariantError");

      const started = yield* decideOrchestrationCommand({
        command: startCommand(),
        readModel: makeReadModel(),
      });
      const event = oneEvent(started);
      expect(event.type).toBe("thread.activity-appended");
      if (event.type === "thread.activity-appended") {
        expect(event.payload.activity.kind).toBe("poteto.requested");
        expect(event.payload.activity.payload).toMatchObject({
          runId: "poteto-start",
          attemptId: "poteto-start",
          spec: SPEC,
          modelSelection: { instanceId: "pi", model: "test/model" },
          progress: { status: "requested", phase: null },
        });
      }

      const activeProvider = yield* Effect.flip(
        decideOrchestrationCommand({
          command: startCommand(CommandId.make("poteto-start-active")),
          readModel: makeReadModel({
            ...makeThread(),
            latestTurn: {
              turnId: TurnId.make("turn-running"),
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
          }),
        }),
      );
      expect(activeProvider._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("uses resolved Pi eligibility for custom instances on start and retry", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("custom-pi");
      const potetoInstanceIds = [instanceId];
      const initial = makeReadModel(
        makeThread({
          modelSelection: { instanceId, model: "test/model" },
        }),
      );
      const started = yield* decideOrchestrationCommand({
        command: startCommand(),
        readModel: initial,
        potetoInstanceIds,
      });
      const withStart = yield* applyEvents(initial, started);
      const finished = yield* decideOrchestrationCommand({
        command: {
          type: "thread.poteto.finish",
          commandId: CommandId.make("custom-finish"),
          threadId: THREAD_ID,
          runId: CommandId.make("poteto-start"),
          attemptId: CommandId.make("poteto-start"),
          progress: {
            runId: CommandId.make("poteto-start"),
            attemptId: CommandId.make("poteto-start"),
            status: "blocked",
            phase: null,
            reason: "Setup failed",
          },
          createdAt: NOW,
        },
        readModel: withStart,
      });
      const readModel = yield* applyEvents(withStart, finished);
      const command = {
        type: "thread.poteto.control" as const,
        commandId: CommandId.make("custom-retry"),
        threadId: THREAD_ID,
        runId: CommandId.make("poteto-start"),
        action: "retry" as const,
        createdAt: NOW,
      };
      const retried = yield* decideOrchestrationCommand({ command, readModel, potetoInstanceIds });
      const withRetry = yield* applyEvents(readModel, retried);
      expect(latestThreadPotetoProgress(asReadModelThread(withRetry).activities)).toMatchObject({
        attemptId: "custom-retry",
        status: "requested",
      });
      const rejectedRetry = yield* Effect.flip(
        decideOrchestrationCommand({
          command,
          readModel,
          potetoInstanceIds: [],
        }),
      );
      expect(rejectedRetry._tag).toBe("OrchestrationCommandInvariantError");
      // A configured id named pi is not necessarily backed by the Pi driver.
      const rejectedStart = yield* Effect.flip(
        decideOrchestrationCommand({
          command: startCommand(),
          readModel: makeReadModel(),
          potetoInstanceIds: [],
        }),
      );
      expect(rejectedStart._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect(
    "locks provider turns, settlement, archive, model changes, and revert until finish",
    () =>
      Effect.gen(function* () {
        const started = yield* decideOrchestrationCommand({
          command: startCommand(),
          readModel: makeReadModel(),
        });
        const readModel = yield* applyEvents(makeReadModel(), started);
        const blockedCommands: ReadonlyArray<OrchestrationCommand> = [
          {
            type: "thread.runtime-mode.set",
            commandId: CommandId.make("poteto-blocked-runtime"),
            threadId: THREAD_ID,
            createdAt: NOW,
            runtimeMode: "full-access",
          },
          {
            type: "thread.turn.start",
            commandId: CommandId.make("poteto-blocked-turn"),
            threadId: THREAD_ID,
            message: {
              messageId: MessageId.make("poteto-blocked-message"),
              role: "user",
              text: "Continue normally",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: NOW,
          },
          {
            type: "thread.settle",
            commandId: CommandId.make("poteto-blocked-settle"),
            threadId: THREAD_ID,
          },
          {
            type: "thread.archive",
            commandId: CommandId.make("poteto-blocked-archive"),
            threadId: THREAD_ID,
          },
          {
            type: "thread.meta.update",
            commandId: CommandId.make("poteto-blocked-model"),
            threadId: THREAD_ID,
            modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "other/model" },
          },
          {
            type: "thread.checkpoint.revert",
            commandId: CommandId.make("poteto-blocked-revert"),
            threadId: THREAD_ID,
            turnCount: 0,
            createdAt: NOW,
          },
        ];
        for (const command of blockedCommands) {
          const rejection = yield* Effect.flip(decideOrchestrationCommand({ command, readModel }));
          expect(rejection._tag).toBe("OrchestrationCommandInvariantError");
        }

        for (const command of [
          {
            type: "thread.meta.update" as const,
            commandId: CommandId.make("poteto-title"),
            threadId: THREAD_ID,
            title: "A new title",
          },
          {
            type: "thread.interaction-mode.set" as const,
            commandId: CommandId.make("poteto-interaction"),
            threadId: THREAD_ID,
            createdAt: NOW,
            interactionMode: "default" as const,
          },
        ]) {
          const events = yield* decideOrchestrationCommand({ command, readModel });
          const updated = yield* applyEvents(readModel, events);
          expect(latestThreadPotetoProgress(asReadModelThread(updated).activities)?.status).toBe(
            "requested",
          );
        }

        const cancelled = yield* decideOrchestrationCommand({
          command: {
            type: "thread.poteto.control",
            commandId: CommandId.make("poteto-cancel"),
            threadId: THREAD_ID,
            runId: CommandId.make("poteto-start"),
            action: "cancel",
            createdAt: NOW,
          },
          readModel,
        });
        const afterCancel = yield* applyEvents(readModel, cancelled);
        expect(latestThreadPotetoProgress(asReadModelThread(afterCancel).activities)).toMatchObject(
          {
            status: "cancelled",
          },
        );
        const stillLocked = yield* Effect.flip(
          decideOrchestrationCommand({
            command: {
              type: "thread.turn.start",
              commandId: CommandId.make("poteto-blocked-after-cancel"),
              threadId: THREAD_ID,
              message: {
                messageId: MessageId.make("poteto-blocked-after-cancel-message"),
                role: "user",
                text: "Not until cleanup ends",
                attachments: [],
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: NOW,
            },
            readModel: afterCancel,
          }),
        );
        expect(stillLocked._tag).toBe("OrchestrationCommandInvariantError");

        const lateAppend = yield* Effect.flip(
          decideOrchestrationCommand({
            command: appendCreatedEvent(
              CommandId.make("poteto-start"),
              CommandId.make("late-append"),
            ),
            readModel: afterCancel,
          }),
        );
        expect(lateAppend._tag).toBe("OrchestrationCommandInvariantError");

        const finished = yield* decideOrchestrationCommand({
          command: {
            type: "thread.poteto.finish",
            commandId: CommandId.make("poteto-cancel-finished"),
            threadId: THREAD_ID,
            runId: CommandId.make("poteto-start"),
            attemptId: CommandId.make("poteto-start"),
            progress: {
              runId: CommandId.make("poteto-start"),
              attemptId: CommandId.make("poteto-start"),
              status: "cancelled",
              phase: null,
              reason: "Cancelled by user",
            },
            createdAt: NOW,
          },
          readModel: afterCancel,
        });
        const afterFinish = yield* applyEvents(afterCancel, finished);
        const normalTurn = yield* decideOrchestrationCommand({
          command: {
            type: "thread.turn.start",
            commandId: CommandId.make("poteto-normal-after-finish"),
            threadId: THREAD_ID,
            message: {
              messageId: MessageId.make("poteto-normal-after-finish-message"),
              role: "user",
              text: "Discuss the result",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: NOW,
          },
          readModel: afterFinish,
        });
        expect(oneEvent(normalTurn).type).toBe("thread.message-sent");
      }),
  );

  it.effect("native Stop durably cancels Poteto without an ordinary provider session", () =>
    Effect.gen(function* () {
      const owner = CommandId.make("poteto-start");
      for (const type of ["thread.turn.interrupt", "thread.session.stop"] as const) {
        for (const status of ["requested", "running", "blocked"] as const) {
          const readModel = yield* makeActivePotetoReadModel(status);
          expect(asReadModelThread(readModel).session).toBeNull();
          expect(latestThreadPotetoProgress(asReadModelThread(readModel).activities)?.status).toBe(
            status,
          );
          const lateAppend =
            status === "requested"
              ? appendCreatedEvent(owner, CommandId.make("native-stop-late-created"))
              : {
                  type: "thread.poteto.append" as const,
                  commandId: CommandId.make("native-stop-late-progress"),
                  threadId: THREAD_ID,
                  runId: owner,
                  attemptId: owner,
                  expectedLength: status === "running" ? 2 : 3,
                  event:
                    status === "running"
                      ? { type: "blocked", phase: "reproduce", reason: "Late worker reply" }
                      : { type: "started", phase: "reproduce" },
                  createdAt: NOW,
                };
          const lateFinish = {
            type: "thread.poteto.finish" as const,
            commandId: CommandId.make("native-stop-late-finish"),
            threadId: THREAD_ID,
            runId: owner,
            attemptId: owner,
            progress: {
              runId: owner,
              attemptId: owner,
              status: "interrupted" as const,
              phase: status === "requested" ? null : ("reproduce" as const),
              reason: "Worker interrupted",
            },
            createdAt: NOW,
          };
          // These worker replies are valid until Stop wins the command transaction.
          yield* decideOrchestrationCommand({ command: lateAppend, readModel });
          yield* decideOrchestrationCommand({ command: lateFinish, readModel });

          const command = {
            type,
            commandId: CommandId.make(`native-stop-${type}-${status}`),
            threadId: THREAD_ID,
            createdAt: "2026-08-30T12:01:00.000Z",
          };
          const planned = yield* decideOrchestrationCommand({ command, readModel });
          const events = Array.isArray(planned) ? planned : [planned];
          const nativeEventType =
            type === "thread.turn.interrupt"
              ? "thread.turn-interrupt-requested"
              : "thread.session-stop-requested";
          expect(events.map((event) => event.type)).toEqual([
            "thread.activity-appended",
            nativeEventType,
          ]);
          for (const event of events) {
            expect(event).toMatchObject({
              commandId: command.commandId,
              correlationId: command.commandId,
              aggregateId: THREAD_ID,
              occurredAt: command.createdAt,
            });
          }
          expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
          expect(events[0]?.payload).toMatchObject({
            threadId: THREAD_ID,
            activity: {
              id: `poteto-control:${command.commandId}`,
              kind: "poteto.control",
              createdAt: command.createdAt,
              payload: {
                runId: owner,
                attemptId: owner,
                action: "cancel",
                progress: { status: "cancelled", reason: "Cancelled by user" },
              },
            },
          });
          expect(events[1]?.payload).toEqual({ threadId: THREAD_ID, createdAt: command.createdAt });
          const afterCancel = yield* applyEvents(readModel, planned);
          expect(readThreadPotetoRun(asReadModelThread(afterCancel))?.progress.status).toBe(
            "cancelled",
          );
          expect(isThreadPotetoActive(asReadModelThread(afterCancel))).toBe(true);
          for (const staleCommand of [lateAppend, lateFinish]) {
            const rejected = yield* Effect.flip(
              decideOrchestrationCommand({ command: staleCommand, readModel: afterCancel }),
            );
            expect(rejected._tag).toBe("OrchestrationCommandInvariantError");
          }
          for (const repeatedType of ["thread.turn.interrupt", "thread.session.stop"] as const) {
            const repeated = yield* decideOrchestrationCommand({
              command: {
                ...command,
                type: repeatedType,
                commandId: CommandId.make(`repeat-${repeatedType}`),
              },
              readModel: afterCancel,
            });
            expect(Array.isArray(repeated)).toBe(false);
            expect(oneEvent(repeated).type).toBe(
              repeatedType === "thread.turn.interrupt"
                ? "thread.turn-interrupt-requested"
                : "thread.session-stop-requested",
            );
            expect(
              latestThreadPotetoProgress(asReadModelThread(afterCancel).activities)?.status,
            ).toBe("cancelled");
          }
          const normalTurn = {
            type: "thread.turn.start" as const,
            commandId: CommandId.make("native-stop-normal-turn"),
            threadId: THREAD_ID,
            message: {
              messageId: MessageId.make("native-stop-normal-message"),
              role: "user" as const,
              text: "Continue normally",
              attachments: [],
            },
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
            createdAt: NOW,
          };
          const retry = {
            type: "thread.poteto.control" as const,
            commandId: CommandId.make("native-stop-retry"),
            threadId: THREAD_ID,
            runId: owner,
            action: "retry" as const,
            createdAt: NOW,
          };
          for (const lockedCommand of [normalTurn, retry]) {
            const rejected = yield* Effect.flip(
              decideOrchestrationCommand({ command: lockedCommand, readModel: afterCancel }),
            );
            expect(rejected._tag).toBe("OrchestrationCommandInvariantError");
          }
          const finish = yield* decideOrchestrationCommand({
            command: {
              ...lateFinish,
              commandId: CommandId.make("native-stop-finished"),
              progress: {
                ...lateFinish.progress,
                status: "cancelled",
                reason: "Cancelled by user",
              },
            },
            readModel: afterCancel,
          });
          const afterFinish = yield* applyEvents(afterCancel, finish);
          expect(isThreadPotetoActive(asReadModelThread(afterFinish))).toBe(false);
          yield* decideOrchestrationCommand({ command: normalTurn, readModel: afterFinish });
          const retried = yield* decideOrchestrationCommand({
            command: retry,
            readModel: afterFinish,
          });
          const afterRetry = yield* applyEvents(afterFinish, retried);
          expect(readThreadPotetoRun(asReadModelThread(afterRetry))?.progress).toMatchObject({
            status: "requested",
            attemptId: retry.commandId,
          });
          expect(isThreadPotetoActive(asReadModelThread(afterRetry))).toBe(true);
          const lockedAgain = yield* Effect.flip(
            decideOrchestrationCommand({ command: normalTurn, readModel: afterRetry }),
          );
          expect(lockedAgain._tag).toBe("OrchestrationCommandInvariantError");
        }
      }
    }),
  );

  it.effect("settle cleanup cannot stop or cancel any unfinished Poteto attempt", () =>
    Effect.gen(function* () {
      for (const status of ["requested", "running", "blocked"] as const) {
        const readModel = yield* makeActivePotetoReadModel(status);
        const cancel = yield* decideOrchestrationCommand({
          command: {
            type: "thread.turn.interrupt",
            commandId: CommandId.make("cleanup-cancel"),
            threadId: THREAD_ID,
            createdAt: NOW,
          },
          readModel,
        });
        const cancelled = yield* applyEvents(readModel, cancel);
        for (const initial of [readModel, cancelled]) {
          // Even a stale pinned-settled snapshot with no provider session is not safe cleanup.
          const settled = makeReadModel({
            ...asReadModelThread(initial),
            settledOverride: "settled",
          });
          const rejected = yield* Effect.flip(
            decideOrchestrationCommand({
              command: {
                type: "thread.session.stop",
                commandId: CommandId.make("stale-settle-cleanup"),
                threadId: THREAD_ID,
                onlyIfSettled: true,
                createdAt: NOW,
              },
              readModel: settled,
            }),
          );
          expect(rejected).toMatchObject({
            _tag: "OrchestrationCommandInvariantError",
            detail: expect.stringContaining("skipping session stop"),
          });
          expect(readThreadPotetoRun(asReadModelThread(settled))?.progress.status).toBe(
            readThreadPotetoRun(asReadModelThread(initial))?.progress.status,
          );
        }
      }
    }),
  );

  it.effect("native Stop leaves absent and finished Poteto runs alone", () =>
    Effect.gen(function* () {
      const readModel = yield* makeActivePotetoReadModel("requested");
      const owner = CommandId.make("poteto-start");
      const finished = yield* decideOrchestrationCommand({
        command: {
          type: "thread.poteto.finish",
          commandId: CommandId.make("native-stop-already-finished"),
          threadId: THREAD_ID,
          runId: owner,
          attemptId: owner,
          progress: {
            runId: owner,
            attemptId: owner,
            status: "blocked",
            phase: null,
            reason: "Setup failed",
          },
          createdAt: NOW,
        },
        readModel,
      });
      const afterFinish = yield* applyEvents(readModel, finished);
      for (const initial of [makeReadModel(), afterFinish]) {
        for (const type of ["thread.turn.interrupt", "thread.session.stop"] as const) {
          const planned = yield* decideOrchestrationCommand({
            command: {
              type,
              commandId: CommandId.make(`inactive-${type}`),
              threadId: THREAD_ID,
              createdAt: NOW,
            },
            readModel: initial,
          });
          expect(Array.isArray(planned)).toBe(false);
          expect(oneEvent(planned).type).toBe(
            type === "thread.turn.interrupt"
              ? "thread.turn-interrupt-requested"
              : "thread.session-stop-requested",
          );
        }
        const cleanup = yield* decideOrchestrationCommand({
          command: {
            type: "thread.session.stop",
            commandId: CommandId.make("finished-settle-cleanup"),
            threadId: THREAD_ID,
            onlyIfSettled: true,
            createdAt: NOW,
          },
          readModel: makeReadModel({ ...asReadModelThread(initial), settledOverride: "settled" }),
        });
        expect(Array.isArray(cleanup)).toBe(false);
        expect(oneEvent(cleanup).type).toBe("thread.session-stop-requested");
      }
    }),
  );

  it.effect("native interrupt retains the ordinary turn id alongside Poteto cancellation", () =>
    Effect.gen(function* () {
      const readModel = yield* makeActivePotetoReadModel("running");
      const turnId = TurnId.make("native-background-turn");
      const planned = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.interrupt",
          commandId: CommandId.make("native-stop-with-turn"),
          threadId: THREAD_ID,
          turnId,
          createdAt: NOW,
        },
        readModel,
      });
      const events = Array.isArray(planned) ? planned : [planned];
      expect(events[1]).toMatchObject({
        type: "thread.turn-interrupt-requested",
        payload: { threadId: THREAD_ID, turnId, createdAt: NOW },
      });
    }),
  );

  it.effect("retries only a finished terminal attempt and rejects stale append owners", () =>
    Effect.gen(function* () {
      const initial = makeReadModel();
      const start = yield* decideOrchestrationCommand({
        command: startCommand(),
        readModel: initial,
      });
      const withStart = yield* applyEvents(initial, start);
      const retryBeforeFinish = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.poteto.control",
            commandId: CommandId.make("retry-too-soon"),
            threadId: THREAD_ID,
            runId: CommandId.make("poteto-start"),
            action: "retry",
            createdAt: NOW,
          },
          readModel: withStart,
        }),
      );
      expect(retryBeforeFinish._tag).toBe("OrchestrationCommandInvariantError");

      const finish = yield* decideOrchestrationCommand({
        command: {
          type: "thread.poteto.finish",
          commandId: CommandId.make("setup-failed"),
          threadId: THREAD_ID,
          runId: CommandId.make("poteto-start"),
          attemptId: CommandId.make("poteto-start"),
          progress: {
            runId: CommandId.make("poteto-start"),
            attemptId: CommandId.make("poteto-start"),
            status: "blocked",
            phase: null,
            reason: "Project setup failed",
          },
          createdAt: NOW,
        },
        readModel: withStart,
      });
      const withFinish = yield* applyEvents(withStart, finish);
      const retry = yield* decideOrchestrationCommand({
        command: {
          type: "thread.poteto.control",
          commandId: CommandId.make("poteto-retry"),
          threadId: THREAD_ID,
          runId: CommandId.make("poteto-start"),
          action: "retry",
          createdAt: NOW,
        },
        readModel: withFinish,
      });
      const withRetry = yield* applyEvents(withFinish, retry);
      expect(latestThreadPotetoProgress(asReadModelThread(withRetry).activities)).toMatchObject({
        attemptId: "poteto-retry",
        status: "requested",
      });

      const stale = yield* Effect.flip(
        decideOrchestrationCommand({
          command: appendCreatedEvent(
            CommandId.make("poteto-start"),
            CommandId.make("stale-attempt-append"),
          ),
          readModel: withRetry,
        }),
      );
      expect(stale._tag).toBe("OrchestrationCommandInvariantError");

      const currentAppend = yield* decideOrchestrationCommand({
        command: appendCreatedEvent(
          CommandId.make("poteto-retry"),
          CommandId.make("retry-created"),
        ),
        readModel: withRetry,
      });
      expect(oneEvent(currentAppend).type).toBe("thread.activity-appended");
    }),
  );

  it.effect("allows blocked recovery appends before finish and bounds empty setup retries", () =>
    Effect.gen(function* () {
      let readModel = makeReadModel();
      readModel = yield* applyEvents(
        readModel,
        yield* decideOrchestrationCommand({
          command: startCommand(),
          readModel,
        }),
      );
      const owner = CommandId.make("poteto-start");
      readModel = yield* applyEvents(
        readModel,
        yield* decideOrchestrationCommand({
          command: appendCreatedEvent(owner, CommandId.make("recovery-created")),
          readModel,
        }),
      );
      const events = [
        { type: "started", phase: "reproduce" },
        { type: "blocked", phase: "reproduce", reason: "Interrupted phase" },
        { type: "started", phase: "reproduce" },
      ];
      for (const [index, event] of events.entries()) {
        readModel = yield* applyEvents(
          readModel,
          yield* decideOrchestrationCommand({
            command: {
              type: "thread.poteto.append",
              commandId: CommandId.make(`recovery-${index}`),
              threadId: THREAD_ID,
              runId: owner,
              attemptId: owner,
              expectedLength: index + 1,
              event,
              createdAt: NOW,
            },
            readModel,
          }),
        );
      }
      expect(latestThreadPotetoProgress(asReadModelThread(readModel).activities)?.status).toBe(
        "running",
      );

      readModel = makeReadModel();
      readModel = yield* applyEvents(
        readModel,
        yield* decideOrchestrationCommand({ command: startCommand(), readModel }),
      );
      let attemptId = owner;
      for (let index = 0; index < 16; index += 1) {
        readModel = yield* applyEvents(
          readModel,
          yield* decideOrchestrationCommand({
            command: {
              type: "thread.poteto.finish",
              commandId: CommandId.make(`setup-finish-${index}`),
              threadId: THREAD_ID,
              runId: owner,
              attemptId,
              progress: {
                runId: owner,
                attemptId,
                status: "blocked",
                phase: null,
                reason: "Setup failed",
              },
              createdAt: NOW,
            },
            readModel,
          }),
        );
        const command = {
          type: "thread.poteto.control" as const,
          commandId: CommandId.make(`setup-retry-${index}`),
          threadId: THREAD_ID,
          runId: owner,
          action: "retry" as const,
          createdAt: NOW,
        };
        if (index === 15) {
          const failure = yield* Effect.flip(decideOrchestrationCommand({ command, readModel }));
          expect(failure._tag).toBe("OrchestrationCommandInvariantError");
        } else {
          readModel = yield* applyEvents(
            readModel,
            yield* decideOrchestrationCommand({ command, readModel }),
          );
          attemptId = command.commandId;
        }
      }
    }),
  );

  it.effect(
    "rejects unsupported candidate finishes and remains compatible with old activity rows",
    () =>
      Effect.gen(function* () {
        const initial = makeReadModel(
          makeThread({
            activities: [
              {
                id: EventId.make("old-tool-activity"),
                tone: "tool",
                kind: "tool.completed",
                summary: "Old activity",
                payload: { data: { output: "legacy" } },
                turnId: null,
                createdAt: NOW,
              },
            ],
          }),
        );
        expect(latestThreadPotetoProgress(asReadModelThread(initial).activities)).toBeUndefined();
        const started = yield* decideOrchestrationCommand({
          command: startCommand(),
          readModel: initial,
        });
        const withStart = yield* applyEvents(initial, started);
        const invalidFinish = yield* Effect.flip(
          decideOrchestrationCommand({
            command: {
              type: "thread.poteto.finish",
              commandId: CommandId.make("fake-candidate-ready"),
              threadId: THREAD_ID,
              runId: CommandId.make("poteto-start"),
              attemptId: CommandId.make("poteto-start"),
              progress: {
                runId: CommandId.make("poteto-start"),
                attemptId: CommandId.make("poteto-start"),
                status: "candidate-ready",
                phase: null,
                reason: null,
                revision: "forged-revision",
              },
              createdAt: NOW,
            },
            readModel: withStart,
          }),
        );
        expect(invalidFinish._tag).toBe("OrchestrationCommandInvariantError");
      }),
  );
});
