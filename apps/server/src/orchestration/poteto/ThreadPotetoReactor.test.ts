// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationEvent,
} from "@rove-code/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";
import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { potetoFixtureReport } from "../../provider/testFixtures/potetoFixture.ts";
import { projectThreadDetailSnapshot } from "../ActivityPayloadProjection.ts";
import { OrchestrationEngineLive } from "../Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import {
  createPotetoMode,
  decodePotetoEvents,
  potetoRevision,
  replayPotetoMode,
  runPotetoMode,
  type PotetoRole,
  type PotetoEvent,
} from "./PotetoMode.ts";
import * as Reactor from "./ThreadPotetoReactor.ts";
import { ThreadPotetoRunner, type ThreadPotetoRunnerInput } from "./ThreadPotetoRunner.ts";
import { isThreadPotetoActive, readThreadPotetoRun } from "./ThreadPotetoState.ts";

const createdAt = "2026-01-01T00:00:00.000Z";
const spec = {
  task: "Fix the inclusive boundary",
  editableFiles: ["discount.ts"],
  contextFiles: [],
  check: { module: "discount.ts", export: "discount", cases: [{ args: [100], expected: 10 }] },
};
const files = [{ path: "discount.ts", content: "export const privateCandidateMarker = 'gt';" }];

function scriptedRunner(
  roles: PotetoRole[],
  before?: (input: ThreadPotetoRunnerInput) => Promise<void>,
): ThreadPotetoRunner["Service"]["run"] {
  return async (input) => {
    if (!input.journal.read().length)
      await createPotetoMode(input.journal, {
        task: spec.task,
        files,
        editablePaths: spec.editableFiles,
        checkId: "trusted-marker",
      });
    const state = await runPotetoMode({
      journal: input.journal,
      signal: input.signal,
      retryBlocked: true,
      resumeInterrupted: true,
      probe: {
        id: "trusted-marker",
        run: async (candidate, signal) => {
          signal.throwIfAborted();
          return {
            outcome: candidate[0]!.content.includes("'gte'") ? "pass" : "fail",
            output: "Trusted boundary result",
          };
        },
      },
      worker: async (request) => {
        roles.push(request.role);
        if (request.role === "implement") await before?.(input);
        input.signal.throwIfAborted();
        return {
          report: potetoFixtureReport(request.role),
          readPaths: ["discount.ts"],
          files:
            request.role === "implement"
              ? request.files.map((file) => ({
                  ...file,
                  content: file.content.replace("'gt'", "'gte'"),
                }))
              : request.files,
        };
      },
    });
    return {
      runId: input.run.runId,
      attemptId: input.run.attemptId,
      status: state.status === "candidate-ready" ? "candidate-ready" : "blocked",
      phase: state.phase ?? null,
      reason: state.reason ?? null,
      revision: potetoRevision(state.files),
    };
  };
}

async function system(
  directory: string,
  runner: ThreadPotetoRunner["Service"]["run"],
  recoverCandidate: ThreadPotetoRunner["Service"]["recoverCandidate"] = async () => {
    throw new Error("No candidate artifacts in this fixture");
  },
) {
  const orchestration = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(makeSqlitePersistenceLive(NodePath.join(directory, "state.sqlite"))),
    Layer.provideMerge(ServerConfig.layerTest(directory, { prefix: "rove-poteto-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  // A disposable runtime per host is required to test SQLite restart recovery.
  // oxlint-disable-next-line rove/no-manual-effect-runtime-in-tests
  const runtime = ManagedRuntime.make(
    Reactor.layer.pipe(
      Layer.provideMerge(orchestration),
      Layer.provide(Layer.succeed(ThreadPotetoRunner, { run: runner, recoverCandidate })),
    ),
  );
  const scope = await runtime.runPromise(Scope.make());
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshots = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const reactor = await runtime.runPromise(Effect.service(Reactor.ThreadPotetoReactor));
  const events = await runtime.runPromise(Queue.unbounded<OrchestrationEvent>());
  await runtime.runPromise(
    Effect.gen(function* () {
      const stream = yield* engine.subscribeDomainEvents;
      yield* Stream.runForEach(stream, (event) => Queue.offer(events, event)).pipe(
        Effect.forkScoped,
      );
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
  return {
    run,
    engine,
    reactor,
    start: () => run(reactor.start().pipe(Effect.provideService(Scope.Scope, scope))),
    finished: (id: ThreadId) =>
      run(
        Effect.gen(function* () {
          while (true) {
            const event = yield* Queue.take(events);
            if (
              event.type === "thread.activity-appended" &&
              event.payload.threadId === id &&
              event.payload.activity.kind === "poteto.finished"
            )
              return event;
          }
        }),
      ),
    thread: async (id: ThreadId) => Option.getOrThrow(await run(snapshots.getThreadDetailById(id))),
    snapshot: async (id: ThreadId) =>
      Option.getOrThrow(await run(snapshots.getThreadDetailSnapshot(id))),
    create: (id: ThreadId) =>
      run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create-${id}`),
          threadId: id,
          projectId: null,
          workspacePath: directory,
          title: "Poteto integration",
          modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "default" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    request: (id: ThreadId) =>
      run(
        engine.dispatch({
          type: "thread.poteto.start",
          commandId: CommandId.make(`run-${id}`),
          threadId: id,
          spec,
          createdAt,
        }),
      ),
    control: (id: ThreadId, action: "cancel" | "retry") =>
      run(
        engine.dispatch({
          type: "thread.poteto.control",
          commandId: CommandId.make(`${action}-${id}`),
          threadId: id,
          runId: CommandId.make(`run-${id}`),
          action,
          createdAt,
        }),
      ),
    dispose: async () => {
      await run(Scope.close(scope, Exit.void));
      await runtime.dispose();
    },
  };
}

async function fixture(test: (directory: string) => Promise<void>) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "rove-poteto-reactor-"));
  try {
    await test(directory);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

describe("ThreadPotetoReactor SQLite integration", () => {
  it("persists the core journal and reconnects with slim progress, not private candidate code", () =>
    fixture(async (directory) => {
      const roles: PotetoRole[] = [];
      const host = await system(directory, scriptedRunner(roles));
      const id = ThreadId.make("candidate");
      try {
        await host.create(id);
        await host.start();
        await host.request(id);
        await host.finished(id);
        await host.run(host.reactor.drain);
        const thread = await host.thread(id);
        const run = readThreadPotetoRun(thread)!;
        expect(run.progress.status).toBe("candidate-ready");
        const events = decodePotetoEvents(run.events);
        expect(events.filter((event) => event.type === "started")).toHaveLength(6);
        expect(events.filter((event) => event.type === "accepted")).toHaveLength(6);
        expect(replayPotetoMode(events).status).toBe("candidate-ready");
        expect(roles).toHaveLength(8);
        const wire = projectThreadDetailSnapshot(await host.snapshot(id));
        expect(JSON.stringify(wire)).not.toContain("privateCandidateMarker");
        expect(JSON.stringify(wire)).toContain("candidate-ready");
      } finally {
        await host.dispose();
      }
      const reconnect = await system(directory, async () => {
        throw new Error("must not resume");
      });
      try {
        await reconnect.start();
        await reconnect.run(reconnect.reactor.drain);
        expect(readThreadPotetoRun(await reconnect.thread(id))!.progress.status).toBe(
          "candidate-ready",
        );
      } finally {
        await reconnect.dispose();
      }
    }));

  it("cancels a waiting worker, drains before unlocking, and retries without repeating accepted phases", () =>
    fixture(async (directory) => {
      const entered = Promise.withResolvers<ThreadPotetoRunnerInput>();
      const unlock = Promise.withResolvers<void>();
      const aborted = Promise.withResolvers<void>();
      const roles: PotetoRole[] = [];
      let attempts = 0;
      const host = await system(
        directory,
        scriptedRunner(roles, async (input) => {
          if (++attempts !== 1) return;
          input.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
          entered.resolve(input);
          await Promise.race([
            unlock.promise,
            new Promise<void>((_, reject) =>
              input.signal.addEventListener("abort", () => reject(input.signal.reason), {
                once: true,
              }),
            ),
          ]);
        }),
      );
      const id = ThreadId.make("cancel");
      try {
        await host.create(id);
        await host.start();
        await host.request(id);
        await entered.promise;
        const accepted = decodePotetoEvents(
          readThreadPotetoRun(await host.thread(id))!.events,
        ).filter((event) => event.type === "accepted");
        expect(accepted).toHaveLength(3);
        await host.control(id, "cancel");
        await aborted.promise;
        await host.finished(id);
        await host.run(host.reactor.drain);
        expect(readThreadPotetoRun(await host.thread(id))!.progress.status).toBe("cancelled");
        expect(
          (await host.thread(id)).activities.some((activity) => activity.kind === "poteto.control"),
        ).toBe(true);
        await host.control(id, "retry");
        await host.finished(id);
        await host.run(host.reactor.drain);
        const run = readThreadPotetoRun(await host.thread(id))!;
        expect(run.runId).toBe(CommandId.make(`run-${id}`));
        expect(run.attemptCount).toBe(2);
        expect(run.progress.status).toBe("candidate-ready");
        expect(
          decodePotetoEvents(run.events).filter((event) => event.type === "accepted"),
        ).toHaveLength(6);
        expect(roles.filter((role) => role === "how")).toHaveLength(1);
      } finally {
        unlock.resolve();
        await host.dispose();
      }
    }));

  it.each(["requested", "running"] as const)(
    "recovers %s as interrupted without launching work, then permits explicit retry",
    (status) =>
      fixture(async (directory) => {
        const id = ThreadId.make("restart");
        const first = await system(directory, async () => {
          throw new Error("not started");
        });
        try {
          await first.create(id);
          await first.request(id);
          if (status === "running") {
            const journal: PotetoEvent[] = [];
            await createPotetoMode(
              {
                read: () => journal,
                append: async (expectedLength, event) => {
                  await first.run(
                    first.engine.dispatch({
                      type: "thread.poteto.append",
                      commandId: CommandId.make(`seed-${expectedLength}`),
                      threadId: id,
                      runId: CommandId.make(`run-${id}`),
                      attemptId: CommandId.make(`run-${id}`),
                      expectedLength,
                      event,
                      createdAt,
                    }),
                  );
                  journal.push(event);
                },
              },
              {
                task: spec.task,
                files,
                editablePaths: spec.editableFiles,
                checkId: "trusted-marker",
              },
            );
            await first.run(
              first.engine.dispatch({
                type: "thread.poteto.append",
                commandId: CommandId.make("seed-started"),
                threadId: id,
                runId: CommandId.make(`run-${id}`),
                attemptId: CommandId.make(`run-${id}`),
                expectedLength: journal.length,
                event: { type: "started", phase: "reproduce" },
                createdAt,
              }),
            );
          }
          expect(readThreadPotetoRun(await first.thread(id))!.progress.status).toBe(status);
        } finally {
          await first.dispose();
        }
        const roles: PotetoRole[] = [];
        const host = await system(directory, scriptedRunner(roles));
        try {
          await host.start();
          await host.finished(id);
          await host.run(host.reactor.drain);
          expect(roles).toEqual([]);
          expect(readThreadPotetoRun(await host.thread(id))!.progress.status).toBe("interrupted");
          await host.control(id, "retry");
          await host.finished(id);
          await host.run(host.reactor.drain);
          expect(readThreadPotetoRun(await host.thread(id))!.progress.status).toBe(
            "candidate-ready",
          );
        } finally {
          await host.dispose();
        }
      }),
  );

  it("recovers an accepted review's patch after a crash before finalization, without inference", () =>
    fixture(async (directory) => {
      const id = ThreadId.make("patch-recovery");
      const first = await system(directory, async () => {
        throw new Error("not started");
      });
      try {
        await first.create(id);
        await first.request(id);
        const run = readThreadPotetoRun(await first.thread(id))!;
        const journal: PotetoEvent[] = [];
        await scriptedRunner([])({
          threadId: id,
          run,
          workspace: directory,
          signal: new AbortController().signal,
          journal: {
            read: () => journal,
            append: async (expectedLength, event) => {
              await first.run(
                first.engine.dispatch({
                  type: "thread.poteto.append",
                  commandId: CommandId.make(`patch-seed-${expectedLength}`),
                  threadId: id,
                  runId: run.runId,
                  attemptId: run.attemptId,
                  expectedLength,
                  event,
                  createdAt,
                }),
              );
              journal.push(event);
            },
          },
        });
      } finally {
        await first.dispose();
      }
      let recovered = 0;
      const host = await system(
        directory,
        async () => {
          throw new Error("recovery must not call a model");
        },
        async ({ run }) => {
          recovered++;
          return {
            ...run.progress,
            revision: potetoRevision(replayPotetoMode(run.events).files),
            patch: "verified candidate patch",
          };
        },
      );
      try {
        await host.start();
        await host.finished(id);
        await host.run(host.reactor.drain);
        expect(recovered).toBe(1);
        expect(readThreadPotetoRun(await host.thread(id))!.progress).toMatchObject({
          status: "candidate-ready",
          patch: "verified candidate patch",
        });
      } finally {
        await host.dispose();
      }
    }));

  it("interrupts a retry setup failure without reusing the previous blocked core or keeping its lock", () =>
    fixture(async (directory) => {
      let attempts = 0;
      const host = await system(directory, async (input) => {
        if (++attempts > 1) {
          expect(input.run.progress.status).toBe("requested");
          throw new Error("retry setup unavailable");
        }
        await createPotetoMode(input.journal, {
          task: spec.task,
          files,
          editablePaths: spec.editableFiles,
          checkId: "trusted-marker",
        });
        const state = await runPotetoMode({
          journal: input.journal,
          signal: input.signal,
          probe: {
            id: "trusted-marker",
            run: async () => ({ outcome: "inconclusive", output: "Cannot reproduce" }),
          },
          worker: async (request) => ({
            report: potetoFixtureReport(request.role),
            readPaths: ["discount.ts"],
            files: request.files,
          }),
        });
        expect(state.status).toBe("blocked");
        return {
          runId: input.run.runId,
          attemptId: input.run.attemptId,
          status: "blocked",
          phase: state.phase ?? null,
          reason: state.reason ?? null,
          revision: potetoRevision(state.files),
        };
      });
      const id = ThreadId.make("blocked-retry-setup");
      try {
        await host.create(id);
        await host.start();
        await host.request(id);
        await host.finished(id);
        await host.run(host.reactor.drain);
        const initial = readThreadPotetoRun(await host.thread(id))!;
        expect(initial.progress.status).toBe("blocked");
        expect(decodePotetoEvents(initial.events)).toContainEqual({
          type: "started",
          phase: "reproduce",
        });
        expect(replayPotetoMode(initial.events).status).toBe("blocked");

        await host.control(id, "retry");
        const finished = await host.finished(id);
        await host.run(host.reactor.drain);
        expect(finished.payload.activity.kind).toBe("poteto.finished");
        const thread = await host.thread(id);
        const retried = readThreadPotetoRun(thread)!;
        expect(retried.progress).toMatchObject({
          status: "interrupted",
          reason: expect.stringContaining("retry setup unavailable"),
        });
        expect(retried.events).toEqual(initial.events);
        expect(retried.attemptCount).toBe(2);
        expect(isThreadPotetoActive(thread)).toBe(false);

        await host.run(
          host.engine.dispatch({
            type: "thread.poteto.control",
            commandId: CommandId.make(`retry-again-${id}`),
            threadId: id,
            runId: initial.runId,
            action: "retry",
            createdAt,
          }),
        );
        await host.finished(id);
        await host.run(host.reactor.drain);
        const finalThread = await host.thread(id);
        expect(readThreadPotetoRun(finalThread)!.attemptCount).toBe(3);
        expect(attempts).toBe(3);
        expect(isThreadPotetoActive(finalThread)).toBe(false);
      } finally {
        await host.dispose();
      }
    }));

  it("runs another thread while a worker is blocked and makes missing-artifact errors visible", () =>
    fixture(async (directory) => {
      const entered = Promise.withResolvers<void>();
      const unlock = Promise.withResolvers<void>();
      const blocked = ThreadId.make("blocked");
      const other = ThreadId.make("other");
      const host = await system(directory, async (input) => {
        if (input.threadId === blocked) {
          entered.resolve();
          await unlock.promise;
          throw new Error("The pinned Poteto artifact directory is missing");
        }
        return scriptedRunner([])(input);
      });
      try {
        await host.create(blocked);
        await host.create(other);
        await host.start();
        await host.request(blocked);
        await entered.promise;
        await host.request(other);
        await host.finished(other);
        expect(readThreadPotetoRun(await host.thread(other))!.progress.status).toBe(
          "candidate-ready",
        );
        unlock.resolve();
        await host.finished(blocked);
        await host.run(host.reactor.drain);
        expect(readThreadPotetoRun(await host.thread(blocked))!.progress).toMatchObject({
          status: "blocked",
          reason: expect.stringContaining("artifact directory is missing"),
        });
      } finally {
        unlock.resolve();
        await host.dispose();
      }
    }));
});
