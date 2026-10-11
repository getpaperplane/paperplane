import type { OrchestrationThread, ThreadId } from "@rove-code/contracts";

const positions = new WeakMap<ReadonlyArray<OrchestrationThread>, ReadonlyMap<ThreadId, number>>();

/** Array identity owns the index; creation, removal and rewind rebuild it lazily. */
export function indexOfThread(threads: ReadonlyArray<OrchestrationThread>, id: ThreadId): number {
  let index = positions.get(threads);
  if (!index) {
    const next = new Map<ThreadId, number>();
    threads.forEach((thread, position) => {
      if (!next.has(thread.id)) next.set(thread.id, position);
    });
    positions.set(threads, next);
    index = next;
  }
  return index.get(id) ?? -1;
}

/** Only for copies that preserve every thread's id and array position. */
export function preserveThreadIndex(
  before: ReadonlyArray<OrchestrationThread>,
  after: ReadonlyArray<OrchestrationThread>,
): void {
  const index = positions.get(before);
  if (index) positions.set(after, index);
}
