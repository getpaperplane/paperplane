import { describe, expect, it } from "vite-plus/test";
import { IDBFactory } from "fake-indexeddb";
import {
  migrateBrowserDatabases,
  migrateBrowserStorage,
  migrateSavedAppJson,
  readMigratedClientStorage,
  readMigratedClientStorageAsync,
  rewriteSavedLinks,
} from "./clientMigration.ts";

function memoryStorage(entries: [string, string][]) {
  const values = new Map(entries);
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
  };
}

describe("one-time client conversion", () => {
  it("moves static and dynamic keys, converts prefs, and deletes old values", () => {
    const storage = memoryStorage([
      ["rove.preferences", '{"themeId":"rove","owner":"rove"}'],
      ["rove:preview-panel-width:env:thread", "350"],
      ["rove.pullRequests.detail:env:pr", '{"text":"[thread](rove-thread://v1/thread-1)"}'],
      ["unrelated", "rove"],
    ]);
    migrateBrowserStorage(storage);
    expect(Object.fromEntries(storage.values)).toEqual({
      "paperplane.preferences": '{"themeId":"paperplane","owner":"paperplane"}',
      "paperplane:preview-panel-width:env:thread": "350",
      "paperplane.pullRequests.detail:env:pr":
        '{"text":"[thread](paperplane-thread://v1/thread-1)"}',
      unrelated: "rove",
    });
    migrateBrowserStorage(storage);
    expect(storage.values.size).toBe(4);
  });

  it("keeps a new preference and removes its stale old key", () => {
    const storage = memoryStorage([
      ["rove.preference", "old"],
      ["paperplane.preference", "new"],
    ]);
    expect(readMigratedClientStorage(storage, "paperplane.preference")).toBe("new");
    expect([...storage.values]).toEqual([["paperplane.preference", "new"]]);
  });

  it("retains the original if writing the new value fails", () => {
    const storage = memoryStorage([["rove.preference", "original"]]);
    expect(() =>
      readMigratedClientStorage(
        {
          ...storage,
          setItem: () => {
            throw new Error("quota");
          },
        },
        "paperplane.preference",
      ),
    ).toThrow("quota");
    expect([...storage.values]).toEqual([["rove.preference", "original"]]);
  });

  it("moves secure-store values once without overwriting the destination", async () => {
    const storage = memoryStorage([["rove.connections", '[{"providerKind":"rove_relay"}]']]);
    const asyncStorage = {
      getItem: async (key: string) => storage.getItem(key),
      setItem: async (key: string, value: string) => storage.setItem(key, value),
      removeItem: async (key: string) => storage.removeItem(key),
    };
    expect(await readMigratedClientStorageAsync(asyncStorage, "paperplane.connections")).toBe(
      '[{"providerKind":"paperplane_relay"}]',
    );
    storage.values.set("rove.connections", "stale");
    expect(await readMigratedClientStorageAsync(asyncStorage, "paperplane.connections")).toBe(
      '[{"providerKind":"paperplane_relay"}]',
    );
    expect(storage.values.has("rove.connections")).toBe(false);
  });

  it("retires cached signed relay claims so they are minted under the new client ID", async () => {
    const storage = memoryStorage([["rove.cloud.relay-access-tokens", "signed-token"]]);
    expect(readMigratedClientStorage(storage, "paperplane.cloud.relay-access-tokens")).toBeNull();
    expect(storage.values.size).toBe(0);
  });

  it("converts owned properties and values while retaining user text and canonical fields", () => {
    const value = {
      roveHome: "/old",
      paperplaneHome: "/new",
      roveCodeRange: ">=1",
      allRove: { cpu: 4 },
      providerKind: "rove_relay",
      credentialOwner: "rove",
      owner: "rove",
      themeId: "rove",
      branchNamePrefix: "rove",
      label: "rove",
      environment: [{ name: "ROVE_HOME", value: "/user/path" }],
      bearerToken: "rove_secret",
      ref: "refs/rove/checkpoints/a",
      text: "Discuss roveHome and rove-thread:// by name.",
    };
    const expected = {
      paperplaneHome: "/new",
      paperplaneCodeRange: ">=1",
      allPaperplane: { cpu: 4 },
      providerKind: "paperplane_relay",
      credentialOwner: "paperplane",
      owner: "paperplane",
      themeId: "paperplane",
      branchNamePrefix: "paperplane",
      label: "rove",
      environment: [{ name: "ROVE_HOME", value: "/user/path" }],
      bearerToken: "rove_secret",
      ref: "refs/paperplane/checkpoints/a",
      text: "Discuss roveHome and rove-thread:// by name.",
    };
    expect(migrateSavedAppJson(value)).toEqual(expected);
    expect(migrateSavedAppJson(expected)).toEqual(expected);
  });

  it("rewrites only complete URIs, preserving bare prose and malformed or unrelated text", () => {
    const text =
      "rove rove-thread:// rove:// [thread](rove-thread://v1/one) [context](rove-context://v1/terminal/ctx) rove-citation://v1/e/t/m?text=a%20b&start=0&end=3&prefix=&suffix= rove-dev://app/ rove-preview://auth/codex rove://new?prompt=hello xrove://new rove://host/%ZZ rove:///missing-host";
    const expected =
      "rove rove-thread:// rove:// [thread](paperplane-thread://v1/one) [context](paperplane-context://v1/terminal/ctx) paperplane-citation://v1/e/t/m?text=a%20b&start=0&end=3&prefix=&suffix= paperplane-dev://app/ paperplane-preview://auth/codex paperplane://new?prompt=hello xrove://new rove://host/%ZZ rove:///missing-host";
    expect(rewriteSavedLinks(text)).toBe(expected);
    expect(rewriteSavedLinks(expected)).toBe(expected);
    expect(
      rewriteSavedLinks(
        "rove-thread://v1/ rove-context://v1/image/ rove-citation://... rove://, ROVE-THREAD://v1/one",
      ),
    ).toBe(
      "rove-thread://v1/ rove-context://v1/image/ rove-citation://... rove://, paperplane-thread://v1/one",
    );
  });
});

it("moves the browser catalog and proof key while clearing cached transcripts, once", async () => {
  const factory = new IDBFactory();
  const open = (name: string, stores: string[]) =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(name);
      request.onupgradeneeded = () => {
        for (const store of stores) request.result.createObjectStore(store);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const seed = async (name: string, stores: Record<string, Record<string, unknown>>) => {
    const db = await open(name, Object.keys(stores));
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(Object.keys(stores), "readwrite");
        for (const [name, entries] of Object.entries(stores)) {
          for (const [key, value] of Object.entries(entries)) tx.objectStore(name).put(value, key);
        }
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  };
  const read = async (name: string, store: string, key: string) => {
    const db = await open(name, []);
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  };
  const proof = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  await seed("rove:connection-runtime", {
    catalog: { state: '{"providerKind":"rove_relay"}', existing: "old" },
    thread: { cached: "[old](rove-thread://v1/thread-1)" },
  });
  await seed("paperplane:connection-runtime", { catalog: { existing: "new" } });
  await seed("rove:cloud-auth", { keys: { primary: proof.privateKey } });
  await seed("rove:project-favicons", { icons: { old: "cached" } });
  await migrateBrowserDatabases(factory);
  expect(await read("paperplane:connection-runtime", "catalog", "state")).toBe(
    '{"providerKind":"paperplane_relay"}',
  );
  expect(await read("paperplane:connection-runtime", "catalog", "existing")).toBe("new");
  expect(await read("paperplane:connection-runtime", "thread", "cached")).toBeUndefined();
  const key = await read("paperplane:cloud-auth", "keys", "primary");
  expect(key).toBeInstanceOf(CryptoKey);
  if (!(key instanceof CryptoKey)) throw new Error("Proof key was lost");
  const data = new TextEncoder().encode("migrated proof");
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data);
  expect(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      proof.publicKey,
      signature,
      data,
    ),
  ).toBe(true);
  expect((await factory.databases()).map((entry) => entry.name).sort()).toEqual([
    "paperplane:cloud-auth",
    "paperplane:connection-runtime",
  ]);
  await migrateBrowserDatabases(factory);
  expect(await read("paperplane:connection-runtime", "catalog", "existing")).toBe("new");
});
