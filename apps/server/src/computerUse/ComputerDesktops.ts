// @effect-diagnostics nodeBuiltinImport:off -- Viewer IDs are opaque process-local capabilities, not container or VM names.
import { randomUUID } from "node:crypto";
import {
  ComputerDesktopViewerError,
  type ComputerDesktop,
  type ComputerDesktopViewer,
  type ComputerDesktopsState,
} from "@getpaperplane/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { Transport } from "./LinuxDesktop.ts";

export type DesktopEndpoint =
  | { readonly kind: "process"; readonly transport: Transport; readonly password: null }
  | {
      readonly kind: "tcp";
      readonly host: string;
      readonly port: number;
      readonly password: string | null;
    };

interface Entry {
  readonly key: string;
  readonly desktop: ComputerDesktop;
  readonly endpoint: Effect.Effect<DesktopEndpoint, ComputerDesktopViewerError>;
  readonly closed: Deferred.Deferred<void>;
}

export class ComputerDesktops extends Context.Service<
  ComputerDesktops,
  {
    readonly changes: Stream.Stream<ComputerDesktopsState>;
    readonly setMode: (mode: ComputerDesktopsState["mode"]) => Effect.Effect<void>;
    readonly register: (
      key: string,
      desktop: Omit<ComputerDesktop, "id" | "startedAt">,
      endpoint: Effect.Effect<DesktopEndpoint, ComputerDesktopViewerError>,
    ) => Effect.Effect<void>;
    readonly remove: (key: string) => Effect.Effect<void>;
    readonly clear: Effect.Effect<void>;
    readonly connection: (id: string) => Effect.Effect<
      {
        readonly endpoint: Effect.Effect<DesktopEndpoint, ComputerDesktopViewerError>;
        readonly closed: Effect.Effect<void>;
      },
      ComputerDesktopViewerError
    >;
    readonly viewer: (
      id: string,
    ) => Effect.Effect<ComputerDesktopViewer, ComputerDesktopViewerError>;
  }
>()("@getpaperplane/server/computerUse/ComputerDesktops") {}

/** One registry per Cua runtime; credentials and teardown signals never enter its public stream. */
export const make = Effect.gen(function* () {
  const state = yield* SubscriptionRef.make<{
    readonly mode: ComputerDesktopsState["mode"];
    readonly entries: ReadonlyArray<Entry>;
    readonly revision: number;
  }>({ mode: "unavailable", entries: [], revision: 0 });
  const remove = Effect.fn("ComputerDesktops.remove")(function* (key: string) {
    const removed = yield* SubscriptionRef.modify(state, (current) => {
      const entry = current.entries.find((entry) => entry.key === key);
      return [
        entry,
        entry
          ? {
              ...current,
              entries: current.entries.filter((entry) => entry.key !== key),
              revision: current.revision + 1,
            }
          : current,
      ];
    });
    if (removed) yield* Deferred.succeed(removed.closed, undefined);
  }, Effect.uninterruptible);
  const connection = Effect.fn("ComputerDesktops.connection")(function* (id: string) {
    const current = yield* SubscriptionRef.get(state);
    const entry = current.entries.find((entry) => entry.desktop.id === id);
    if (!entry || current.mode !== "isolated")
      return yield* new ComputerDesktopViewerError({ desktopId: id });
    return {
      endpoint: entry.endpoint.pipe(
        Effect.mapError(() => new ComputerDesktopViewerError({ desktopId: id })),
      ),
      closed: Deferred.await(entry.closed),
    };
  });
  const clear = Effect.gen(function* () {
    for (const entry of (yield* SubscriptionRef.get(state)).entries) yield* remove(entry.key);
  });
  yield* Effect.addFinalizer(() => clear);
  return ComputerDesktops.of({
    changes: SubscriptionRef.changes(state).pipe(
      Stream.map(({ mode, entries, revision }) => ({
        mode,
        desktops: entries.map((entry) => entry.desktop),
        revision,
      })),
      Stream.changesWith((a, b) => a.revision === b.revision),
    ),
    setMode: Effect.fn("ComputerDesktops.setMode")(function* (mode) {
      if (mode !== "isolated") yield* clear;
      yield* SubscriptionRef.update(state, (current) =>
        current.mode === mode ? current : { ...current, mode, revision: current.revision + 1 },
      );
    }),
    register: Effect.fn("ComputerDesktops.register")(function* (key, desktop, endpoint) {
      const closed = yield* Deferred.make<void>();
      const startedAt = DateTime.formatIso(yield* DateTime.now);
      yield* SubscriptionRef.update(state, (current) =>
        current.entries.some((entry) => entry.key === key)
          ? current
          : {
              ...current,
              entries: [
                ...current.entries,
                { key, desktop: { ...desktop, id: randomUUID(), startedAt }, endpoint, closed },
              ],
              revision: current.revision + 1,
            },
      );
    }),
    remove,
    clear,
    connection,
    viewer: Effect.fn("ComputerDesktops.viewer")(function* (id) {
      const current = yield* connection(id);
      const endpoint = yield* current.endpoint;
      return { path: `/api/computer-use/desktops/${id}/vnc`, password: endpoint.password };
    }),
  });
});

export const layer = Layer.effect(ComputerDesktops, make);
