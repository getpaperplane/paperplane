import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import { FrameCoalescing, latestPerFrame } from "./frameCoalescing.ts";

const FRAME = "16 millis";
const UPDATES = 500;

/** Applies one state update every 4 ms, as live socket frames do while a reply streams. */
const streamUpdates = (pace: (changes: Stream.Stream<number>) => Stream.Stream<number>) =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make(0);
    const published: number[] = [];
    const consumer = yield* pace(SubscriptionRef.changes(state)).pipe(
      Stream.runForEach((value) => Effect.sync(() => published.push(value))),
      Effect.forkScoped,
    );
    yield* TestClock.adjust("0 millis");
    for (let update = 1; update <= UPDATES; update++) {
      yield* SubscriptionRef.set(state, update);
      yield* TestClock.adjust("4 millis");
    }
    yield* TestClock.adjust(FRAME);
    yield* Fiber.interrupt(consumer);
    return published;
  }).pipe(Effect.provideService(FrameCoalescing, { nextFrame: Effect.sleep(FRAME) }));

describe("latestPerFrame", () => {
  it.effect("publishes at most one state per frame and always the latest", () =>
    Effect.gen(function* () {
      const unpaced = yield* streamUpdates((changes) => changes);
      const paced = yield* streamUpdates(latestPerFrame);
      expect(unpaced).toHaveLength(UPDATES + 1);
      // 500 updates over 2 s of 16 ms frames.
      expect(paced.length).toBeLessThanOrEqual(UPDATES / 4 + 2);
      expect(paced.at(-1)).toBe(UPDATES);
      expect(paced).toEqual(paced.toSorted((left, right) => left - right));
    }),
  );

  it.effect("publishes a change after a quiet frame without waiting for the next one", () =>
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make("idle");
      const published: string[] = [];
      yield* latestPerFrame(SubscriptionRef.changes(state)).pipe(
        Stream.runForEach((value) => Effect.sync(() => published.push(value))),
        Effect.forkScoped,
      );
      yield* TestClock.adjust("0 millis");
      yield* TestClock.adjust("100 millis");
      yield* SubscriptionRef.set(state, "completed");
      yield* TestClock.adjust("0 millis");
      expect(published).toEqual(["idle", "completed"]);
    }).pipe(Effect.provideService(FrameCoalescing, { nextFrame: Effect.sleep(FRAME) })),
  );

  it.effect("passes every value through where frames do not exist", () =>
    Effect.gen(function* () {
      const values = yield* latestPerFrame(Stream.make(1, 2, 3)).pipe(Stream.runCollect);
      expect(values).toEqual([1, 2, 3]);
    }),
  );
});
