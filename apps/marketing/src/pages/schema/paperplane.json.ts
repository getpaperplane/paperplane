import type { APIRoute } from "astro";

import { buildRoveProjectFileJsonSchema } from "@getpaperplane/shared/roveProjectFile";

// Rendered at build time and served at /schema/paperplane.json so paperplane.json files can
// reference it via "$schema" for editor/LSP support.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildRoveProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
