import { EnvironmentId, ThreadId, type ThreadHandoff } from "@rove-code/contracts";
import { threadKey } from "@rove-code/client-runtime/state/entities";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";

const saved = new Map<string, string>();
let store: typeof import("./threadHandoffStore").useThreadHandoffStore;
const handoff: ThreadHandoff = {
  version: 1,
  transferId: "web-transfer",
  sourceEnvironmentId: EnvironmentId.make("source"),
  sourceThreadId: ThreadId.make("original"),
  sourceLabel: "Laptop",
  title: "Original",
  repositoryKey: "github.com/acme/repo",
  branch: "feature",
  commitSha: "a".repeat(40),
  sourceTurnId: null,
  sourceSequence: 1,
  createdAt: "2026-10-11T00:00:00.000Z",
  items: [],
  omittedItems: 2,
  omittedAttachments: 1,
};
const target = {
  environmentId: EnvironmentId.make("target"),
  threadId: ThreadId.make("continued"),
};
const key = threadKey(target);
const storageKey = "rove-thread-handoff-outbox-v1";

beforeAll(async () => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
  store = (await import("./threadHandoffStore")).useThreadHandoffStore;
});
beforeEach(() => {
  saved.clear();
  store.setState({ pending: {} });
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  vi.unstubAllGlobals();
});

it("rejects a send's outbox write when browser storage is unavailable", () => {
  vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new Error("Storage full");
  });
  expect(() => store.getState().enqueue({ ...target, handoff })).toThrow("Storage full");
});

it("keeps unsent provenance durable across reload and only completes an acknowledged backlink", async () => {
  store.getState().enqueue({ ...target, handoff });
  const persisted = saved.get(storageKey)!;
  expect(store.getState().pending[key]).toMatchObject({ ready: false, handoff });
  store.setState({ pending: {} });
  saved.set(storageKey, persisted);
  await store.persist.rehydrate();
  expect(store.getState().pending[key]).toMatchObject({ ready: false, handoff });
  store.getState().markReady(target);
  expect(store.getState().pending[key]?.ready).toBe(true);
  expect(JSON.parse(saved.get(storageKey)!).state.pending[key].ready).toBe(true);
  store.getState().complete(key);
  expect(store.getState().pending).toEqual({});
  expect(JSON.parse(saved.get(storageKey)!).state.pending).toEqual({});
});
