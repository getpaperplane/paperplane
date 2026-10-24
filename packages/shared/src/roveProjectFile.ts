import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { RoveProjectFile, PAPERPLANE_PROJECT_FILE_SCHEMA_URL } from "@getpaperplane/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `paperplane.json` file contents (lenient JSONC string) and the
 * decoded {@link RoveProjectFile}.
 */
export const RoveProjectFileFromJson = fromLenientJson(RoveProjectFile);

const decodeRoveProjectFile = Schema.decodeExit(RoveProjectFileFromJson);

/**
 * Decode raw `paperplane.json` contents, treating invalid or malformed files as
 * absent. Used when resolving the configuration of a newly checked-out worktree.
 */
export function parseRoveProjectFile(contents: string): RoveProjectFile | null {
  const decoded = decodeRoveProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

/**
 * Build the publishable JSON Schema document for `paperplane.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link PAPERPLANE_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildRoveProjectFileJsonSchema(): Record<string, unknown> {
  // Closed objects, as before effect rc.113 changed the generator default;
  // editors then flag unknown keys in paperplane.json.
  const document = Schema.toJsonSchemaDocument(RoveProjectFile, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: PAPERPLANE_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
