/** One-time Paperplane conversion. Delete this module and its startup hooks after the migration window. */
import type { Json } from "effect/Schema";
import { parseAssistantCitationHref } from "./assistantCitations.ts";
import { parseComposerContextHref } from "./composerContextReferences.ts";
import { parseThreadLinkHref } from "./threadLinks.ts";

const propertyNames = new Map([
  ["roveHome", "paperplaneHome"],
  ["roveCodeRange", "paperplaneCodeRange"],
  ["allRove", "allPaperplane"],
]);
const valueNames = new Map([
  ["providerKind", new Map([["rove_relay", "paperplane_relay"]])],
  ["owner", new Map([["rove", "paperplane"]])],
  ["credentialOwner", new Map([["rove", "paperplane"]])],
  [
    "clientId",
    new Map([
      ["rove-mobile", "paperplane-mobile"],
      ["rove-web", "paperplane-web"],
    ]),
  ],
  ["branchNamePrefix", new Map([["rove", "paperplane"]])],
  ...["themeId", "lightThemeId", "darkThemeId", "theme", "light", "dark"].map(
    (field) =>
      [
        field,
        new Map([
          ["rove", "paperplane"],
          ["rove-ocean", "ocean"],
          ["rove-ember", "ember"],
        ]),
      ] as const,
  ),
]);

/** Preserve every byte except a complete URI's scheme prefix. Bare names and malformed URIs stay intact. */
export function rewriteSavedLinks(text: string): string {
  return text.replace(
    /(?<![a-z0-9+.-])rove(?:-thread|-context|-citation|-dev|-preview)?:\/\/[^\s<>"'`\\)\]}]+/gi,
    (href) => {
      if (/%(?![a-f0-9]{2})/i.test(href)) return href;
      try {
        const url = new URL(href);
        if (!/[a-z0-9]/i.test(url.hostname) || url.username || url.password) return href;
        const next =
          url.protocol.replace(/^rove/, "paperplane") + href.slice(href.indexOf(":") + 1);
        if (url.protocol === "rove-thread:" && parseThreadLinkHref(next) === null) return href;
        if (url.protocol === "rove-context:" && parseComposerContextHref(next) === null)
          return href;
        if (url.protocol === "rove-citation:" && parseAssistantCitationHref(next) === null)
          return href;
        return next;
      } catch {
        return href;
      }
    },
  );
}

/** App-owned JSON only. Opaque credentials and user-authored environment maps are not renamed. */
export function migrateSavedAppJson(value: Json): Json {
  if (typeof value === "string") {
    if (/^refs\/rove\/[^\s]+$/.test(value))
      return value.replace(/^refs\/rove\//, "refs/paperplane/");
    return rewriteSavedLinks(value);
  }
  if (Array.isArray(value)) return value.map(migrateSavedAppJson);
  if (value === null || typeof value !== "object") return value;
  const result: { [key: string]: Json } = {};
  for (const [field, entry] of Object.entries(value)) {
    const name = propertyNames.get(field) ?? field;
    if (name !== field && Object.hasOwn(value, name)) continue;
    result[name] =
      name === "payload" && typeof entry === "string"
        ? migrateStoredClientValue(entry)
        : typeof entry === "string"
          ? (valueNames.get(name)?.get(entry) ?? migrateSavedAppJson(entry))
          : migrateSavedAppJson(entry);
  }
  return result;
}

export function migrateStoredClientValue(raw: string, key?: string): string {
  if (key === "paperplane:theme") {
    const aliases = new Map([
      ["rove", "paperplane"],
      ["rove-ocean", "ocean"],
      ["rove-ember", "ember"],
    ]);
    return aliases.get(raw) ?? raw;
  }
  try {
    // JSON.parse is followed by a JSON-only recursive transform, never by a domain assertion.
    return JSON.stringify(migrateSavedAppJson(JSON.parse(raw)));
  } catch {
    return rewriteSavedLinks(raw);
  }
}

function previousStorageKey(key: string): string | undefined {
  return /^paperplane[.:]/.test(key) ? key.replace(/^paperplane/, "rove") : undefined;
}

interface ClientStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readMigratedClientStorage(storage: ClientStorage, key: string): string | null {
  const current = storage.getItem(key);
  const previousKey = previousStorageKey(key);
  if (previousKey === undefined) return current;
  if (current !== null) {
    storage.removeItem(previousKey);
    return current;
  }
  const previous = storage.getItem(previousKey);
  if (previous === null) return null;
  if (key === "paperplane.cloud.relay-access-tokens") {
    storage.removeItem(previousKey);
    return null;
  }
  const migrated = migrateStoredClientValue(previous, key);
  storage.setItem(key, migrated);
  storage.removeItem(previousKey);
  return migrated;
}

export async function readMigratedClientStorageAsync(
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<unknown>;
    removeItem(key: string): Promise<unknown>;
  },
  key: string,
): Promise<string | null> {
  const current = await storage.getItem(key);
  const previousKey = previousStorageKey(key);
  if (previousKey === undefined) return current;
  if (current !== null) {
    await storage.removeItem(previousKey);
    return current;
  }
  const previous = await storage.getItem(previousKey);
  if (previous === null) return null;
  if (key === "paperplane.cloud.relay-access-tokens") {
    await storage.removeItem(previousKey);
    return null;
  }
  const migrated = migrateStoredClientValue(previous, key);
  await storage.setItem(key, migrated);
  await storage.removeItem(previousKey);
  return migrated;
}

/** Run before importing the web app, including modules that read preferences during evaluation. */
export function migrateBrowserStorage(
  storage: ClientStorage & { readonly length: number; key(index: number): string | null },
): void {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) {
    if (key !== null && /^rove[.:]/.test(key)) {
      readMigratedClientStorage(storage, key.replace(/^rove/, "paperplane"));
    }
  }
}

// A side-effect import comes first in the web entry point. Mobile has no Web Storage.
for (const name of ["localStorage", "sessionStorage"]) {
  try {
    const storage: unknown = Reflect.get(globalThis, name);
    if (isBrowserStorage(storage)) migrateBrowserStorage(storage);
  } catch {
    /* Restricted browsers can deny storage entirely. */
  }
}

function isBrowserStorage(
  value: unknown,
): value is ClientStorage & { readonly length: number; key(index: number): string | null } {
  return (
    typeof value === "object" &&
    value !== null &&
    "getItem" in value &&
    typeof value.getItem === "function" &&
    "setItem" in value &&
    typeof value.setItem === "function" &&
    "removeItem" in value &&
    typeof value.removeItem === "function" &&
    "key" in value &&
    typeof value.key === "function" &&
    "length" in value &&
    typeof value.length === "number"
  );
}

// Keep DOM globals out of Node and native type environments. These are the
// standard IndexedDB methods this one-time adapter uses, with string-owned keys.
interface DatabaseRequest<T> {
  readonly result: T;
  readonly error: unknown;
  addEventListener(type: string, listener: () => void): void;
}
interface DatabaseCursor {
  readonly primaryKey: unknown;
  readonly value: unknown;
  continue(): void;
}
interface DatabaseStore {
  openCursor(): DatabaseRequest<DatabaseCursor | null>;
  get(key: string): DatabaseRequest<unknown>;
  add(value: unknown, key: string): unknown;
}
interface DatabaseTransaction {
  readonly error: unknown;
  objectStore(name: string): DatabaseStore;
  addEventListener(type: string, listener: () => void): void;
}
interface ClientDatabase {
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(name: string, mode: "readonly" | "readwrite"): DatabaseTransaction;
  close(): void;
}
export interface ClientDatabaseFactory {
  databases(): Promise<{ readonly name?: string }[]>;
  open(name: string, version?: number): DatabaseRequest<ClientDatabase>;
  deleteDatabase(name: string): DatabaseRequest<unknown>;
}

/** Move the connection catalog and non-exportable proof key; discard transcript/config/favicon caches. */
export async function migrateBrowserDatabases(factory: ClientDatabaseFactory): Promise<void> {
  const definitions = [
    {
      previous: "rove:connection-runtime",
      current: "paperplane:connection-runtime",
      version: 4,
      stores: ["catalog", "shell", "thread", "server-config", "vcs-refs"],
      preserve: ["catalog"],
    },
    {
      previous: "rove:cloud-auth",
      current: "paperplane:cloud-auth",
      version: 1,
      stores: ["keys"],
      preserve: ["keys"],
    },
    {
      previous: "rove:project-favicons",
      current: "paperplane:project-favicons",
      version: 1,
      stores: [],
      preserve: [],
    },
  ];
  const open = (name: string, version?: number, stores: readonly string[] = []) =>
    new Promise<ClientDatabase>((resolve, reject) => {
      const request = factory.open(name, version);
      request.addEventListener("upgradeneeded", () => {
        for (const store of stores)
          if (!request.result.objectStoreNames.contains(store))
            request.result.createObjectStore(store);
      });
      request.addEventListener("error", () => reject(request.error));
      request.addEventListener("blocked", () =>
        reject(new Error("Close other Paperplane tabs to finish migrating local storage.")),
      );
      request.addEventListener("success", () => resolve(request.result));
    });
  const databases = await factory.databases();
  for (const definition of definitions) {
    if (!databases.some((entry) => entry.name === definition.previous)) continue;
    const old = await open(definition.previous);
    let next: ClientDatabase | undefined;
    try {
      if (definition.preserve.length > 0) {
        next = await open(definition.current, definition.version, definition.stores);
        for (const name of definition.preserve) {
          if (!old.objectStoreNames.contains(name)) continue;
          const entries = await new Promise<{ key: string; value: unknown }[]>(
            (resolve, reject) => {
              const transaction = old.transaction(name, "readonly");
              const values: { key: string; value: unknown }[] = [];
              const request = transaction.objectStore(name).openCursor();
              request.addEventListener("success", () => {
                const cursor = request.result;
                if (cursor === null) return;
                if (typeof cursor.primaryKey !== "string")
                  throw new Error("Unexpected non-string owned storage key.");
                values.push({ key: cursor.primaryKey, value: cursor.value });
                cursor.continue();
              });
              transaction.addEventListener("complete", () => resolve(values));
              transaction.addEventListener("abort", () => reject(transaction.error));
            },
          );
          const target = next;
          await new Promise<void>((resolve, reject) => {
            const transaction = target.transaction(name, "readwrite");
            const store = transaction.objectStore(name);
            for (const entry of entries) {
              const existing = store.get(entry.key);
              existing.addEventListener("success", () => {
                if (existing.result === undefined)
                  store.add(
                    typeof entry.value === "string"
                      ? migrateStoredClientValue(entry.value)
                      : entry.value,
                    entry.key,
                  );
              });
            }
            transaction.addEventListener("complete", () => resolve());
            transaction.addEventListener("abort", () => reject(transaction.error));
          });
        }
      }
    } finally {
      old.close();
      next?.close();
    }
    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase(definition.previous);
      request.addEventListener("success", () => resolve());
      request.addEventListener("error", () => reject(request.error));
      request.addEventListener("blocked", () =>
        reject(new Error("Close other Paperplane tabs to retire the old cache.")),
      );
    });
  }
}

interface MobileMigrationDatabase {
  execAsync(source: string): Promise<void>;
  getFirstAsync<T>(source: string): Promise<T | null>;
  runAsync(source: string, ...params: (string | number | null)[]): Promise<unknown>;
  closeAsync(): Promise<void>;
  withExclusiveTransactionAsync(
    task: (transaction: MobileMigrationDatabase) => Promise<void>,
  ): Promise<void>;
}

/** Mobile IDs require reinstalling, but persisted dev clients can still carry the old database. */
export async function openMigratedMobileDatabase<D extends MobileMigrationDatabase>(sqlite: {
  openDatabaseAsync(name: string): Promise<D>;
  deleteDatabaseAsync(name: string): Promise<void>;
}): Promise<D> {
  const next = await sqlite.openDatabaseAsync("paperplane-client.db");
  try {
    const marker = await next.getFirstAsync<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE name = 'paperplane_name_migration'",
    );
    if (marker !== null) return next;
    const old = await sqlite.openDatabaseAsync("rove-client.db");
    try {
      const preferencesTable = await old.getFirstAsync<{ name: string }>(
        "SELECT name FROM sqlite_schema WHERE name = 'client_preferences'",
      );
      const preferences =
        preferencesTable === null
          ? null
          : await old.getFirstAsync<{ payload: string; updated_at: number }>(
              "SELECT payload, updated_at FROM client_preferences WHERE singleton = 1",
            );
      await next.withExclusiveTransactionAsync(async (transaction) => {
        await transaction.execAsync(
          "CREATE TABLE IF NOT EXISTS client_preferences (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), payload TEXT NOT NULL, updated_at INTEGER NOT NULL)",
        );
        if (preferences !== null)
          await transaction.runAsync(
            "INSERT INTO client_preferences VALUES (1, ?, ?) ON CONFLICT (singleton) DO NOTHING",
            migrateStoredClientValue(preferences.payload),
            preferences.updated_at,
          );
        // Do not reimport the pre-SQLite transcript files after deliberately dropping cached links.
        await transaction.execAsync(
          "PRAGMA user_version = 1; CREATE TABLE IF NOT EXISTS paperplane_name_migration (completed INTEGER)",
        );
      });
    } finally {
      await old.closeAsync();
    }
    await sqlite.deleteDatabaseAsync("rove-client.db");
    return next;
  } catch (error) {
    await next.closeAsync();
    throw error;
  }
}

const browserDatabaseMigrations = new WeakMap<ClientDatabaseFactory, Promise<void>>();
export function prepareBrowserDatabases(factory: ClientDatabaseFactory): Promise<void> {
  let pending = browserDatabaseMigrations.get(factory);
  if (pending === undefined) {
    pending = migrateBrowserDatabases(factory);
    browserDatabaseMigrations.set(factory, pending);
    void pending.catch(() => browserDatabaseMigrations.delete(factory));
  }
  return pending;
}
