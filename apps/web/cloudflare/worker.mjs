import { escapeHtml } from "./content.ts";

// Keep these in step with TanStack's public routes; a parity test checks the generated tree.
export const appRoutes = [
  "/",
  "/connect",
  "/connect-agent",
  "/new",
  "/pair",
  "/settings",
  "/usage",
  "/welcome",
  "/pull-requests",
  "/projects/$projectKey",
  "/draft/$draftId",
  "/$environmentId/$threadId",
  ...[
    "appearance",
    "archived",
    "connections",
    "diagnostics",
    "general",
    "integrations",
    "keybindings",
    "open-source-licenses",
    "projects",
    "providers",
    "scheduled-tasks",
    "snap-shot",
    "source-control",
    "storage",
  ].map((page) => `/settings/${page}`),
];

const reservedPrefixes = new Set([
  "api",
  "assets",
  "docs",
  "settings",
  "draft",
  "projects",
  ".well-known",
  "oauth",
  "ws",
]);

export function isAppRoute(pathname) {
  const segments = pathname.split("/").slice(1);
  return appRoutes.some((route) => {
    const pattern = route.split("/").slice(1);
    if (pattern.length !== segments.length) return false;
    // Thread identifiers are owned by paired environments, not this public origin.
    // Reserve content/asset/API namespaces so missing resources cannot become thread routes.
    if (route === "/$environmentId/$threadId" && reservedPrefixes.has(segments[0])) return false;
    return pattern.every((segment, index) =>
      segment.startsWith("$") ? segments[index].length > 0 : segments[index] === segment,
    );
  });
}

// RFC 9110: the most specific matching range determines a representation's quality,
// including q=0 exclusions. Prefer HTML on equal quality (and for an absent Accept).
export function negotiate(accept, supported) {
  const ranges = (accept ?? "*/*").split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((entry) => {
    const [media, ...rawParameters] = entry
      .trim()
      .toLowerCase()
      .split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const parameters = rawParameters.map((parameter) => parameter.trim());
    const weightIndex = parameters.findIndex((parameter) => parameter.startsWith("q="));
    const rawQuality = weightIndex === -1 ? "1" : parameters[weightIndex].slice(2);
    const q = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(rawQuality) ? Number(rawQuality) : 0;
    const mediaParameters = weightIndex === -1 ? parameters : parameters.slice(0, weightIndex);
    // Every negotiated response uses UTF-8. Other media parameters describe a
    // different representation, not a request to silently ignore those parameters.
    const matchesParameters = mediaParameters.every((parameter) =>
      /^charset=(?:utf-8|"utf-8")$/.test(parameter),
    );
    return { media: media.trim(), q, matchesParameters, parameterCount: mediaParameters.length };
  });
  let selected;
  let bestQuality = 0;
  for (const type of supported) {
    let specificity = -1;
    let parameterCount = -1;
    let quality = 0;
    for (const range of ranges) {
      if (!range.matchesParameters) continue;
      const match =
        range.media === type
          ? 2
          : range.media === `${type.split("/")[0]}/*`
            ? 1
            : range.media === "*/*"
              ? 0
              : -1;
      if (match < 0) continue;
      if (match > specificity || (match === specificity && range.parameterCount > parameterCount)) {
        specificity = match;
        parameterCount = range.parameterCount;
        quality = range.q;
      } else if (match === specificity && range.parameterCount === parameterCount) {
        quality = Math.max(quality, range.q);
      }
    }
    if (quality > bestQuality) {
      selected = type;
      bestQuality = quality;
    }
  }
  return selected;
}

function withVary(response, type) {
  const headers = new Headers(response.headers);
  const vary =
    headers
      .get("Vary")
      ?.split(",")
      .map((entry) => entry.trim()) ?? [];
  if (!vary.some((entry) => entry.toLowerCase() === "accept" || entry === "*")) vary.push("Accept");
  headers.set("Vary", vary.join(", "));
  if (type) headers.set("Content-Type", `${type}; charset=utf-8`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function errorResponse(request, status, code, message, hint, jsonOnly = false) {
  const type = jsonOnly
    ? "application/json"
    : (negotiate(request.headers.get("Accept"), [
        "text/html",
        "text/markdown",
        "application/json",
      ]) ?? "application/json");
  const error = { code, message, hint, docs: "/docs" };
  const body =
    type === "application/json"
      ? JSON.stringify({ error })
      : type === "text/markdown"
        ? `# ${status} — ${code}\n\n${message}\n\n${hint}\n\nSee the [connection guide](/docs), [agent guide](/llms.txt), or [sitemap](/sitemap.xml).\n`
        : `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${status} — Paperplane</title></head><body><main><h1>${status} — ${code}</h1><p>${escapeHtml(message)}</p><p>${escapeHtml(hint)}</p><p><a href="/docs">Connection guide</a> · <a href="/llms.txt">Agent guide</a> · <a href="/">Paperplane</a></p></main></body></html>`;
  const headers = new Headers({
    "Content-Type": `${type}; charset=utf-8`,
    Vary: "Accept",
    "Cache-Control": "no-store",
  });
  if (status === 405) headers.set("Allow", "GET, HEAD");
  return new Response(request.method === "HEAD" ? null : body, { status, headers });
}

const resources = {
  "/index.md": ["text/markdown"],
  "/docs.md": ["text/markdown"],
  "/llms.txt": ["text/plain"],
  "/robots.txt": ["text/plain"],
  "/sitemap.xml": ["application/xml"],
  "/openapi.json": ["application/json"],
  "/schema/rove.json": ["application/schema+json", "application/json"],
};

// Other URLs stay asset-first: existing bundles are free static requests, while
// missing assets still reach this handler. Explicit exclusions would bypass 404 negotiation.
export const workerFirstPaths = [
  "/",
  "/index.html",
  "/docs",
  "/docs/*",
  "/api",
  "/api/*",
  ...Object.keys(resources),
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const isApi = pathname === "/api" || pathname.startsWith("/api/");
    if (isApi) {
      return errorResponse(
        request,
        404,
        "HOST_REQUIRED",
        "This hosted browser app has no public agent execution API.",
        "Pair your own HTTPS Paperplane environment in Settings → Connections. Do not send credentials to this origin.",
        true,
      );
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse(
        request,
        405,
        "METHOD_NOT_ALLOWED",
        "This origin serves read-only browser assets and documentation.",
        "Use GET or HEAD. Agent operations belong to your paired environment.",
      );
    }

    const isHome = pathname === "/" || pathname === "/index.html";
    const isDocs = ["/docs", "/docs/", "/docs/index.html"].includes(pathname);
    const types = isHome || isDocs ? ["text/html", "text/markdown"] : resources[pathname];
    if (types) {
      const type = negotiate(request.headers.get("Accept"), types);
      if (!type) {
        return errorResponse(
          request,
          406,
          "NOT_ACCEPTABLE",
          "No acceptable representation is available for this resource.",
          `Request one of: ${types.join(", ")}.`,
        );
      }
      url.pathname = isHome
        ? type === "text/markdown"
          ? "/index.md"
          : "/index.html"
        : isDocs
          ? type === "text/markdown"
            ? "/docs.md"
            : "/docs/index.html"
          : pathname;
      const response = await env.ASSETS.fetch(new Request(url, request));
      return withVary(response, type);
    }

    // No SPA fallback at the binding: genuinely missing assets retain their 404.
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
    const appPath = pathname.replace(/\/$/, "") || "/";
    if (isAppRoute(appPath)) {
      url.pathname = "/index.html";
      return env.ASSETS.fetch(new Request(url, request));
    }
    return errorResponse(
      request,
      404,
      "NOT_FOUND",
      "The requested resource does not exist on this Paperplane site.",
      "Check the URL or discover available resources in /docs, /llms.txt, and /sitemap.xml.",
    );
  },
};
