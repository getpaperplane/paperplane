// @effect-diagnostics nodeBuiltinImport:off -- The SDK must load from disk beside its Webpack chunks.
import * as NodeModule from "node:module";

// Cursor's Webpack chunks and local helpers must stay beside the SDK entry.
// createRequire also loads that disk-backed package from a Node SEA executable.
const requireCursorSdk = NodeModule.createRequire(import.meta.url);
let sdk: typeof import("@cursor/sdk") | undefined;
let sqlite: typeof import("@cursor/sdk/sqlite") | undefined;

/** Catalogs and sign-in need the SDK, but not its SQLite agent store. */
export function loadCursorSdk(): typeof import("@cursor/sdk") {
  // SAFETY: This disk-backed entry is the installed package described by its SDK declarations.
  return (sdk ??= requireCursorSdk("@cursor/sdk") as typeof import("@cursor/sdk"));
}

export function loadCursorSqlite(): typeof import("@cursor/sdk/sqlite") {
  // SAFETY: The SQLite entry and its declarations ship together in the same SDK package.
  return (sqlite ??= requireCursorSdk("@cursor/sdk/sqlite") as typeof import("@cursor/sdk/sqlite"));
}
