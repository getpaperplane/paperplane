import {
  type PiExtensionStatusSnapshot,
  type ThreadId,
  PiExtensionStatusSnapshot as Snapshot,
} from "@rove-code/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

const EMPTY: PiExtensionStatusSnapshot = { statuses: [] };
const decodeSnapshot = Schema.decodeUnknownOption(Snapshot);

/** Live session state only: never part of the transcript or a persisted projection. */
export class PiExtensionStatuses extends Context.Service<
  PiExtensionStatuses,
  {
    readonly open: (threadId: ThreadId) => Effect.Effect<
      {
        readonly publish: (snapshot: unknown) => Effect.Effect<void>;
        readonly clear: Effect.Effect<void>;
      },
      never,
      Scope.Scope
    >;
    readonly subscribe: (threadId: ThreadId) => Stream.Stream<PiExtensionStatusSnapshot>;
  }
>()("@rove-code/server/provider/PiExtensionStatuses") {}

const make = () => {
  type Entry = {
    owner: symbol | undefined;
    latest: PiExtensionStatusSnapshot;
    subscribers: Set<Queue.Queue<PiExtensionStatusSnapshot>>;
  };
  const entries = new Map<ThreadId, Entry>();
  const entryFor = (threadId: ThreadId) => {
    let entry = entries.get(threadId);
    if (!entry) {
      entry = { owner: undefined, latest: EMPTY, subscribers: new Set() };
      entries.set(threadId, entry);
    }
    return entry;
  };
  const prune = (threadId: ThreadId, entry: Entry) => {
    if (entries.get(threadId) === entry && !entry.owner && entry.subscribers.size === 0)
      entries.delete(threadId);
  };
  const publish = (entry: Entry, snapshot: PiExtensionStatusSnapshot) => {
    if (
      entry.latest.statuses.length === snapshot.statuses.length &&
      entry.latest.statuses.every(
        (status, index) =>
          status.key === snapshot.statuses[index]!.key &&
          status.text === snapshot.statuses[index]!.text,
      )
    )
      return;
    entry.latest = snapshot;
    for (const queue of entry.subscribers) Queue.offerUnsafe(queue, snapshot);
  };
  return PiExtensionStatuses.of({
    open: Effect.fn("PiExtensionStatuses.open")(function* (threadId) {
      const entry = entryFor(threadId);
      const owner = Symbol();
      entry.owner = owner;
      publish(entry, EMPTY);
      const clear = Effect.sync(() => {
        if (entry.owner !== owner) return;
        entry.owner = undefined;
        publish(entry, EMPTY);
        prune(threadId, entry);
      });
      yield* Effect.addFinalizer(() => clear);
      return {
        publish: (snapshot) =>
          Effect.sync(() => {
            if (entry.owner !== owner) return;
            // One malformed entry must not blank every other extension's status; a
            // snapshot with nothing valid left is ignored rather than clearing the bar.
            const raw = (snapshot as { readonly statuses?: unknown } | null)?.statuses;
            const entries: unknown = Array.isArray(raw)
              ? raw.filter((status) => Option.isSome(decodeSnapshot({ statuses: [status] })))
              : raw;
            if (
              Array.isArray(raw) &&
              raw.length > 0 &&
              Array.isArray(entries) &&
              entries.length === 0
            )
              return;
            const decoded = decodeSnapshot({ statuses: entries });
            if (Option.isSome(decoded)) publish(entry, decoded.value);
          }),
        clear,
      };
    }),
    subscribe: (threadId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Registration and replay happen together: no snapshot/tail gap, and a slow
          // viewer retains only the latest update, never an unbounded status history.
          const queue = yield* Queue.sliding<PiExtensionStatusSnapshot>(1);
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const entry = entryFor(threadId);
              entry.subscribers.add(queue);
              Queue.offerUnsafe(queue, entry.latest);
              return entry;
            }),
            (entry) =>
              Effect.sync(() => {
                entry.subscribers.delete(queue);
                prune(threadId, entry);
              }),
          );
          return Stream.fromQueue(queue);
        }),
      ),
  });
};

export const layer = Layer.sync(PiExtensionStatuses, make);
