import type { EnvironmentId, ThreadId, ThreadHandoff } from "@rove-code/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { threadKey } from "@rove-code/client-runtime/state/entities";

export interface PendingThreadHandoff {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly handoff: ThreadHandoff;
  readonly ready: boolean;
}

/** Durable backlink outbox. Destination provenance commits in the bootstrap transaction flow. */
export const useThreadHandoffStore = create<{
  pending: Readonly<Record<string, PendingThreadHandoff>>;
  enqueue: (target: Omit<PendingThreadHandoff, "ready">) => void;
  markReady: (target: { environmentId: EnvironmentId; threadId: ThreadId }) => void;
  complete: (key: string) => void;
}>()(
  persist(
    (set) => ({
      pending: {},
      enqueue: (target) =>
        set((state) => ({
          pending: { ...state.pending, [threadKey(target)]: { ...target, ready: false } },
        })),
      markReady: (target) =>
        set((state) => {
          const key = threadKey(target);
          const pending = state.pending[key];
          return pending
            ? { pending: { ...state.pending, [key]: { ...pending, ready: true } } }
            : state;
        }),
      complete: (key) =>
        set((state) => {
          const { [key]: _completed, ...pending } = state.pending;
          return { pending };
        }),
    }),
    {
      name: "rove-thread-handoff-outbox-v1",
      // Resolve storage on use: a storage failure must reject a send, not
      // silently turn this durable outbox into an in-memory one.
      storage: createJSONStorage(() => ({
        getItem: (name) => localStorage.getItem(name),
        setItem: (name, value) => localStorage.setItem(name, value),
        removeItem: (name) => localStorage.removeItem(name),
      })),
      partialize: ({ pending }) => ({ pending }),
    },
  ),
);
