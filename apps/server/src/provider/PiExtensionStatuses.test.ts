import { assert, it } from "@effect/vitest";
import { ThreadId } from "@getpaperplane/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as PiExtensionStatuses from "./PiExtensionStatuses.ts";

const thread = ThreadId.make("pi-status");
const other = ThreadId.make("other");
const empty = { statuses: [] };
const snapshot = (text: string) => ({ statuses: [{ key: "extension", text }] });

it.effect(
  "replays the latest snapshot, isolates threads, and clears without transcript history",
  () =>
    Effect.gen(function* () {
      const statuses = yield* PiExtensionStatuses.PiExtensionStatuses;
      const owner = yield* statuses.open(thread);
      const otherOwner = yield* statuses.open(other);
      const ready = yield* Deferred.make<void>();
      const updated = yield* Deferred.make<void>();
      const collected = yield* statuses.subscribe(thread).pipe(
        Stream.tap((value) =>
          value.statuses.length === 0
            ? Deferred.succeed(ready, undefined)
            : Deferred.succeed(updated, undefined),
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(ready);
      yield* otherOwner.publish(snapshot("not this thread"));
      yield* owner.publish(snapshot("running"));
      yield* Deferred.await(updated);
      assert.deepEqual(
        Option.getOrThrow(yield* statuses.subscribe(thread).pipe(Stream.runHead)),
        snapshot("running"),
      );
      yield* owner.publish(snapshot("running"));
      yield* owner.clear;
      assert.deepEqual(Array.from(yield* Fiber.join(collected)), [
        empty,
        snapshot("running"),
        empty,
      ]);
      assert.deepEqual(
        Option.getOrThrow(yield* statuses.subscribe(other).pipe(Stream.runHead)),
        snapshot("not this thread"),
      );
    }).pipe(Effect.scoped, Effect.provide(PiExtensionStatuses.layer)),
);

it.effect("a slow subscriber retains only the latest bounded update", () =>
  Effect.gen(function* () {
    const statuses = yield* PiExtensionStatuses.PiExtensionStatuses;
    const owner = yield* statuses.open(thread);
    const ready = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let first = true;
    const collected = yield* statuses.subscribe(thread).pipe(
      Stream.tap(() => {
        if (!first) return Effect.void;
        first = false;
        return Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(release)));
      }),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.await(ready);
    for (let index = 0; index < 100; index++) yield* owner.publish(snapshot(String(index)));
    yield* Deferred.succeed(release, undefined);
    assert.deepEqual(Array.from(yield* Fiber.join(collected)), [empty, snapshot("99")]);
  }).pipe(Effect.scoped, Effect.provide(PiExtensionStatuses.layer)),
);

it.effect("old session updates and finalizers cannot clear a replacement session", () =>
  Effect.gen(function* () {
    const statuses = yield* PiExtensionStatuses.PiExtensionStatuses;
    const oldScope = yield* Scope.make();
    const old = yield* statuses.open(thread).pipe(Effect.provideService(Scope.Scope, oldScope));
    yield* old.publish(snapshot("old"));
    const nextScope = yield* Scope.make();
    const next = yield* statuses.open(thread).pipe(Effect.provideService(Scope.Scope, nextScope));
    yield* next.publish(snapshot("new"));
    yield* old.publish(snapshot("late old update"));
    yield* Scope.close(oldScope, Exit.void);
    const latest = yield* statuses.subscribe(thread).pipe(Stream.runHead);
    assert.deepEqual(Option.getOrThrow(latest), snapshot("new"));
    yield* Scope.close(nextScope, Exit.void);
    assert.deepEqual(
      Option.getOrThrow(yield* statuses.subscribe(thread).pipe(Stream.runHead)),
      empty,
    );
  }).pipe(Effect.scoped, Effect.provide(PiExtensionStatuses.layer)),
);

it.effect("rejects malformed or oversized SDK status snapshots", () =>
  Effect.gen(function* () {
    const statuses = yield* PiExtensionStatuses.PiExtensionStatuses;
    const owner = yield* statuses.open(thread);
    yield* owner.publish(snapshot("valid"));
    for (const invalid of [
      { statuses: null },
      snapshot("x".repeat(4097)),
      { statuses: [{ key: "k".repeat(121), text: "x" }] },
      { statuses: Array.from({ length: 65 }, () => ({ key: "k", text: "x" })) },
      { statuses: Array.from({ length: 3 }, () => ({ key: "k", text: "x".repeat(4096) })) },
    ])
      yield* owner.publish(invalid);
    assert.deepEqual(
      Option.getOrThrow(yield* statuses.subscribe(thread).pipe(Stream.runHead)),
      snapshot("valid"),
    );
  }).pipe(Effect.scoped, Effect.provide(PiExtensionStatuses.layer)),
);

it.effect("drops only malformed entries instead of the whole snapshot", () =>
  Effect.gen(function* () {
    const statuses = yield* PiExtensionStatuses.PiExtensionStatuses;
    const owner = yield* statuses.open(thread);
    yield* owner.publish({
      statuses: [
        { key: "good", text: "ok" },
        { key: "blank", text: "   " },
      ],
    });
    assert.deepEqual(Option.getOrThrow(yield* statuses.subscribe(thread).pipe(Stream.runHead)), {
      statuses: [{ key: "good", text: "ok" }],
    });
  }).pipe(Effect.scoped, Effect.provide(PiExtensionStatuses.layer)),
);
