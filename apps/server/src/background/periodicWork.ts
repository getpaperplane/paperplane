import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "./BackgroundPolicy.ts";

/** Idle/constrained hosts keep a safety pass; events still use the caller's immediate path. */
export const makePeriodicWork = Effect.gen(function* () {
  const policy = yield* BackgroundPolicy.BackgroundPolicy;
  return Effect.fnUntraced(function* <E, R>(
    work: Effect.Effect<void, E, R>,
    options: { readonly runImmediately?: boolean } = {},
  ) {
    const wake = yield* Queue.sliding<void>(1);
    const subscription = yield* policy.subscribe;
    let allowed = subscription.latest.shouldRunOpportunisticWork;
    yield* Stream.runForEach(subscription.changes, (snapshot) => {
      const resumed = !allowed && snapshot.shouldRunOpportunisticWork;
      allowed = snapshot.shouldRunOpportunisticWork;
      return resumed ? Queue.offer(wake, undefined).pipe(Effect.asVoid) : Effect.void;
    }).pipe(Effect.forkScoped);
    if (options.runImmediately !== false) yield* work;
    return yield* Effect.forever(
      Effect.gen(function* () {
        // Leases can expire between published changes, so check live policy, not a cached flag.
        const active = yield* policy.shouldRunOpportunisticWork;
        yield* Effect.raceFirst(Queue.take(wake), Effect.sleep(active ? "1 minute" : "15 minutes"));
        yield* work;
      }),
    );
  });
});
