import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

// Hidden browser windows stop animation frames; the timer keeps state moving.
const HIDDEN_FRAME_FALLBACK = "50 millis";

const nextAnimationFrame = Effect.raceFirst(
  Effect.callback<void>((resume) => {
    const handle = globalThis.requestAnimationFrame(() => resume(Effect.void));
    return Effect.sync(() => globalThis.cancelAnimationFrame(handle));
  }),
  Effect.sleep(HIDDEN_FRAME_FALLBACK),
);

/**
 * Paces UI state publication to the display. Browsers and React Native provide
 * animation frames; elsewhere (servers, unit tests) publication is not paced.
 * `nextFrame` completes at the next frame.
 */
export class FrameCoalescing extends Context.Reference<{
  readonly nextFrame: Effect.Effect<void> | null;
}>("@getpaperplane/client-runtime/platform/FrameCoalescing", {
  defaultValue: () => ({
    nextFrame:
      typeof globalThis.requestAnimationFrame === "function" &&
      typeof globalThis.cancelAnimationFrame === "function"
        ? nextAnimationFrame
        : null,
  }),
}) {}

/**
 * Emits at most one value per frame, always the latest. A value arriving after a
 * quiet frame emits immediately, so a lone change (a run finishing, a request
 * opening) is never delayed; a burst emits its first value, then its latest once
 * per frame. Only use this for streams of whole states, where a skipped value is
 * superseded by the next.
 */
export const latestPerFrame = <A, E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { nextFrame } = yield* FrameCoalescing;
      if (nextFrame === null) return self;
      return Stream.callback<A, E, R>((queue) =>
        Effect.gen(function* () {
          const scope = yield* Scope.Scope;
          let pending: { readonly value: A } | undefined;
          let publishing = false;
          let frames: Fiber.Fiber<void> | undefined;
          // Runs while values keep arriving: each frame publishes the latest one.
          const publishEachFrame = Effect.gen(function* () {
            while (true) {
              yield* nextFrame;
              if (pending === undefined) break;
              Queue.offerUnsafe(queue, pending.value);
              pending = undefined;
            }
            publishing = false;
          });
          const receive = (value: A) =>
            Effect.suspend(() => {
              if (publishing) {
                pending = { value };
                return Effect.void;
              }
              publishing = true;
              Queue.offerUnsafe(queue, value);
              return Effect.forkIn(publishEachFrame, scope).pipe(
                Effect.map((fiber) => {
                  frames = fiber;
                }),
              );
            });
          yield* self.pipe(
            Stream.runForEach(receive),
            Effect.exit,
            Effect.flatMap((exit) =>
              Effect.gen(function* () {
                if (frames !== undefined) yield* Fiber.interrupt(frames);
                if (pending !== undefined) Queue.offerUnsafe(queue, pending.value);
                if (Exit.isSuccess(exit)) Queue.endUnsafe(queue);
                else Queue.failCauseUnsafe(queue, exit.cause);
              }),
            ),
            Effect.forkScoped,
          );
        }),
      );
    }),
  );
