import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";

import { forkParked } from "../serverActivation.ts";

const SAFETY_INTERVAL_MS = 15 * 60 * 1_000;
// Failed dispatches or corrupt, already-due rows must not create a hot retry loop.
const RETRY_INTERVAL_MS = 5_000;

/** Sources load due work from durable state; registration owns execution and returns an early wake. */
export class Scheduler extends Context.Service<
  Scheduler,
  {
    readonly register: <E, R>(
      name: string,
      runDueWork: Effect.Effect<void, E, R>,
      nextDueAt?: Effect.Effect<number | null, E, R>,
    ) => Effect.Effect<{ readonly wake: Effect.Effect<void> }, never, R | Scope.Scope>;
  }
>()("@rove-code/server/scheduling/Scheduler") {}

const make = Effect.gen(function* () {
  const changed = yield* Queue.sliding<void>(1);
  const sources = new Map<symbol, { nextAt: number; running: boolean; run: Effect.Effect<void> }>();
  const notify = Queue.offer(changed, undefined).pipe(Effect.asVoid);
  const register: Scheduler["Service"]["register"] = Effect.fn("Scheduler.register")(function* <
    E,
    R,
  >(
    name: string,
    runDueWork: Effect.Effect<void, E, R>,
    nextDueAt?: Effect.Effect<number | null, E, R>,
  ) {
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<R>();
    const id = Symbol(name);
    let dirty = false;
    const source = { nextAt: 0, running: false, run: Effect.void };
    const wake = Effect.sync(() => {
      dirty = true;
      source.nextAt = 0;
    }).pipe(Effect.andThen(notify));
    const work = Effect.gen(function* () {
      dirty = false;
      let due: number | null = null;
      yield* runDueWork;
      if (nextDueAt !== undefined) due = yield* nextDueAt;
      const now = yield* Clock.currentTimeMillis;
      source.nextAt = Math.min(
        now + SAFETY_INTERVAL_MS,
        Math.max(now + RETRY_INTERVAL_MS, due ?? Infinity),
      );
    }).pipe(
      Effect.provideContext(context),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          source.nextAt = (yield* Clock.currentTimeMillis) + SAFETY_INTERVAL_MS;
          if (!Cause.hasInterruptsOnly(cause))
            yield* Effect.logWarning("Scheduler source failed", { source: name, cause });
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          source.running = false;
          // A mutation during execution belongs to the next pass, not the snapshot we just read.
          if (dirty) source.nextAt = 0;
        }).pipe(Effect.andThen(notify)),
      ),
    );
    source.run = Effect.suspend(() => {
      if (source.running) return Effect.void;
      source.running = true;
      return work.pipe(Effect.forkIn(scope), Effect.asVoid);
    });
    yield* Effect.acquireRelease(
      Effect.sync(() => sources.set(id, source)).pipe(Effect.andThen(notify)),
      () => Effect.sync(() => sources.delete(id)).pipe(Effect.andThen(notify)),
    );
    return { wake };
  });
  // One deadline timer for every source. Re-read wall time after every wake, and
  // cap sleeps to survive wall-clock jumps and machine suspend without lost work.
  yield* forkParked(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      for (const source of sources.values()) {
        if (!source.running && source.nextAt <= now) yield* source.run;
      }
      const next = Math.min(
        now + SAFETY_INTERVAL_MS,
        ...[...sources.values()].filter((source) => !source.running).map((source) => source.nextAt),
      );
      yield* Effect.raceFirst(Queue.take(changed), Effect.sleep(Math.max(0, next - now)));
    }).pipe(Effect.forever),
  );
  return Scheduler.of({ register });
});

export const layer = Layer.effect(Scheduler, make);
