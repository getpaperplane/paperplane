import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as BackgroundPolicy from "./BackgroundPolicy.ts";
import { makePeriodicWork } from "./periodicWork.ts";
import { policySnapshot } from "./testkit.ts";

it.effect(
  "backs off idle passes, resumes immediately, and does not reset its timer on heartbeats",
  () =>
    Effect.gen(function* () {
      const active = yield* Ref.make(false);
      const changes = yield* PubSub.sliding<ReturnType<typeof policySnapshot>>(1);
      const ready = yield* Deferred.make<void>();
      const receipts = yield* Queue.unbounded<void>();
      const layer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunOpportunisticWork: Ref.get(active),
        subscribe: Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          yield* Deferred.succeed(ready, undefined);
          return {
            latest: policySnapshot(yield* Ref.get(active)),
            changes: Stream.fromSubscription(subscription),
          };
        }),
      });
      yield* Effect.gen(function* () {
        const periodicWork = yield* makePeriodicWork;
        yield* periodicWork(Queue.offer(receipts, undefined).pipe(Effect.asVoid)).pipe(
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        yield* Queue.take(receipts);
        yield* TestClock.adjust("14 minutes");
        assert.equal(yield* Queue.size(receipts), 0);
        yield* TestClock.adjust("1 minute");
        yield* Queue.take(receipts);
        yield* Ref.set(active, true);
        yield* PubSub.publish(changes, policySnapshot(true));
        yield* Queue.take(receipts);
        yield* TestClock.adjust("30 seconds");
        yield* PubSub.publish(changes, policySnapshot(true));
        yield* TestClock.adjust("30 seconds");
        yield* Queue.take(receipts);
        yield* Ref.set(active, false);
        yield* PubSub.publish(changes, policySnapshot(false));
        // The already-armed foreground pass finishes, then backs off.
        yield* TestClock.adjust("1 minute");
        yield* Queue.take(receipts);
        yield* TestClock.adjust("14 minutes");
        assert.equal(yield* Queue.size(receipts), 0);
        yield* TestClock.adjust("1 minute");
        yield* Queue.take(receipts);
      }).pipe(Effect.provide(layer));
    }),
);
