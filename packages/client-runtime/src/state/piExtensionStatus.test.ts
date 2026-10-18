import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  WS_METHODS,
  type PiExtensionStatusSnapshot,
} from "@rove-code/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { testDouble } from "../testDouble.ts";
import { createPiExtensionStatusAtoms } from "./piExtensionStatus.ts";

it.effect(
  "shares live viewers by environment/thread, applies clears, and disposes subscriptions",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("one");
      const otherThreadId = ThreadId.make("two");
      const environmentId = EnvironmentId.make("host");
      const otherEnvironmentId = EnvironmentId.make("other-host");
      const sources = new Map<
        string,
        {
          state: SubscriptionRef.SubscriptionRef<PiExtensionStatusSnapshot>;
          closed: Deferred.Deferred<void>;
        }
      >();
      for (const [env, thread] of [
        [environmentId, threadId],
        [environmentId, otherThreadId],
        [otherEnvironmentId, threadId],
      ] as const) {
        sources.set(`${env}:${thread}`, {
          state: yield* SubscriptionRef.make<PiExtensionStatusSnapshot>({ statuses: [] }),
          closed: yield* Deferred.make<void>(),
        });
      }
      const calls: string[] = [];
      const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
        env,
        stream,
      ) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const session = testDouble<RpcSession>({
              client: {
                [WS_METHODS.piExtensionStatusesSubscribe]: (input: { threadId: ThreadId }) => {
                  const key = `${env}:${input.threadId}`;
                  const source = sources.get(key)!;
                  calls.push(key);
                  return SubscriptionRef.changes(source.state).pipe(
                    Stream.ensuring(Deferred.succeed(source.closed, undefined)),
                  );
                },
              },
            });
            const supervisor = testDouble<EnvironmentSupervisor.EnvironmentSupervisor["Service"]>({
              target: { environmentId: env },
              session: yield* SubscriptionRef.make(Option.some(session)),
            });
            return stream.pipe(
              Stream.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            );
          }),
        );
      const runtime = Atom.runtime(
        Layer.succeed(
          EnvironmentRegistry.EnvironmentRegistry,
          testDouble<EnvironmentRegistry.EnvironmentRegistry["Service"]>({ followStream }),
        ),
      );
      const atoms = createPiExtensionStatusAtoms(runtime);
      const first = atoms.snapshot({ environmentId, input: { threadId } });
      assert.strictEqual(first, atoms.snapshot({ environmentId, input: { threadId } }));
      const second = atoms.snapshot({ environmentId, input: { threadId: otherThreadId } });
      const remote = atoms.snapshot({ environmentId: otherEnvironmentId, input: { threadId } });
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const watch = (atom: typeof first) => registry.subscribe(atom, () => {}, { immediate: true });
      const unwatch = [watch(first), watch(first), watch(second), watch(remote)];
      for (const atom of [first, second, remote]) yield* AtomRegistry.getResult(registry, atom);
      const changed = yield* Deferred.make<void>();
      const cleared = yield* Deferred.make<void>();
      const stopObserving = registry.subscribe(first, (result) => {
        if (!AsyncResult.isSuccess(result)) return;
        if (result.value.statuses[0]?.text === "working") Deferred.doneUnsafe(changed, Exit.void);
        if (result.value.statuses.length === 0 && Deferred.isDoneUnsafe(changed))
          Deferred.doneUnsafe(cleared, Exit.void);
      });
      const source = sources.get(`${environmentId}:${threadId}`)!;
      yield* SubscriptionRef.set(source.state, { statuses: [{ key: "task", text: "working" }] });
      yield* Deferred.await(changed);
      for (const atom of [second, remote]) {
        const result = registry.get(atom);
        assert.isTrue(AsyncResult.isSuccess(result));
        if (AsyncResult.isSuccess(result)) assert.deepEqual(result.value, { statuses: [] });
      }
      yield* SubscriptionRef.set(source.state, { statuses: [] });
      yield* Deferred.await(cleared);
      assert.deepEqual(calls.toSorted(), [...sources.keys()].toSorted());
      stopObserving();
      for (const stop of unwatch) stop();
      registry.dispose();
      for (const source of sources.values()) yield* Deferred.await(source.closed);
    }).pipe(Effect.scoped),
);
