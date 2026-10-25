// Shared by the hosted build and its public documentation. No paired-host API is exposed here.
export const homepage = {
  title: "Paperplane — a workspace for coding agents",
  introduction:
    "Paperplane is an open-source interface for working with coding agents across web, desktop, and mobile. Bring your own provider subscription or API credentials and keep your repositories, terminals, and agent sessions on a computer you control. Paperplane supports Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity, and Pi.",
  sections: [
    {
      title: "Connect your own environment",
      text: "This hosted browser app does not run agents or store your repositories on a public backend. Install the Paperplane CLI or desktop app on your computer, authenticate a provider there, and pair that environment in Settings → Connections using its HTTPS address and a one-time pairing code. Keep your host running while you work. JavaScript is required for the interactive workspace, but these guides can be read without it.",
    },
    {
      title: "Work with your agents",
      text: "Organize projects and conversation threads, review code changes, use terminals, and follow streaming agent responses in one workspace. Local hosts can also connect over LAN, Tailscale, or SSH; the public HTTPS browser app needs a reachable HTTPS host. Web, desktop, and mobile clients can connect to your own environments without a hosted Paperplane account.",
    },
    {
      title: "Resources for people and agents",
      text: "Read the connection guide before pairing. The OpenAPI document describes this site's public, read-only content endpoints, not the private WebSocket protocol used by paired environments. Never send provider credentials or pairing codes to this site's documentation endpoints.",
    },
  ],
  links: [
    ["Connection guide", "/docs"],
    ["Agent guide", "/llms.txt"],
    ["OpenAPI specification", "/openapi.json"],
    ["Sitemap", "/sitemap.xml"],
    ["Source code", "https://github.com/getpaperplane/paperplane"],
    [
      "Install Paperplane",
      "https://github.com/getpaperplane/paperplane/blob/main/docs/user/install.md",
    ],
  ] satisfies [string, string][],
};

const docs = {
  title: "Connect to Paperplane",
  introduction:
    "The public Paperplane website is a browser client. Your own Paperplane environment runs the backend and coding providers. Documentation endpoints on this origin are public and read-only; they cannot start turns, access files, or authenticate a provider.",
  sections: [
    {
      title: "Install and start your host",
      text: "Install the Paperplane desktop app or CLI using the installation guide. Authenticate at least one supported provider on that computer. For a persistent CLI host, run `paperplane service install --host 127.0.0.1 --port 3773`, then check it with `paperplane service status`. Keep pairing authentication enabled. Do not publish someone else's pairing code or expose their host.",
    },
    {
      title: "Pair the browser app",
      text: "Make your host reachable through a trusted HTTPS endpoint, such as a private Tailscale endpoint or your own Cloudflare Tunnel. Create a one-time code with `paperplane auth pairing create`. In the browser app, open Settings → Connections, add the environment's HTTPS address, and enter that code. A plain HTTP LAN address cannot be used from the public HTTPS app. Keep the host and any tunnel running while you work.",
    },
    {
      title: "Discover public content",
      text: "Request `/` or `/docs` with `Accept: text/markdown` for Markdown, or `Accept: text/html` for HTML. Both representations set `Vary: Accept`. Direct Markdown files are available at `/index.md` and `/docs.md`. `/openapi.json` documents these public resources, and `/schema/paperplane.json` is the JSON Schema for a project's paperplane.json configuration. Unknown resources return HTTP 404. Unsupported methods return 405 with an Allow header. Unsupported representations return 406.",
    },
    {
      title: "Understand the API boundary",
      text: "There is no public agent execution API on this hosted origin. Requests to `/api` and its subpaths return JSON errors with a code, message, resolution hint, and documentation link. Pair your own environment to use the workspace. Its authenticated WebSocket protocol is separate from the read-only OpenAPI document on this site.",
    },
  ],
  links: [
    ["Open browser app", "/"],
    [
      "Install Paperplane",
      "https://github.com/getpaperplane/paperplane/blob/main/docs/user/install.md",
    ],
    ["Source code", "https://github.com/getpaperplane/paperplane"],
    ["Agent guide", "/llms.txt"],
    ["OpenAPI specification", "/openapi.json"],
  ] satisfies [string, string][],
};

function markdownContent(page: typeof homepage) {
  return `# ${page.title}\n\n${page.introduction}\n\n${page.sections
    .map((section) => `## ${section.title}\n\n${section.text}`)
    .join("\n\n")}\n\n## Links\n\n${page.links
    .map(([label, url]) => `- [${label}](${url})`)
    .join("\n")}\n`;
}

export function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

export function htmlContent(page: typeof homepage) {
  return `<h1>${escapeHtml(page.title)}</h1>\n<p>${escapeHtml(page.introduction)}</p>\n${page.sections
    .map((section) => `<h2>${escapeHtml(section.title)}</h2>\n<p>${escapeHtml(section.text)}</p>`)
    .join("\n")}\n<h2>Links</h2>\n<ul>${page.links
    .map(([label, url]) => `<li><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></li>`)
    .join("\n")}</ul>`;
}

function htmlDocument(page: typeof homepage) {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(page.title)}</title></head><body><main>${htmlContent(page)}</main></body></html>\n`;
}

export function publicFiles(origin: string) {
  return {
    "index.md": markdownContent(homepage),
    "docs.md": markdownContent(docs),
    "docs/index.html": htmlDocument(docs),
    "llms.txt": `# Paperplane\n\n> Open-source web, desktop, and mobile workspace for coding agents. Bring your own host and provider credentials.\n\nThis origin serves a browser client and public documentation only. It has no public agent execution API. Do not send secrets here. JavaScript is needed for the workspace, not for these resources.\n\n## Documentation\n\n- [Overview](${origin}/index.md): Product overview and connection requirements.\n- [Connection guide](${origin}/docs.md): Install, start, and pair your own host.\n- [Installation](https://github.com/getpaperplane/paperplane/blob/main/docs/user/install.md): Desktop and CLI setup.\n\n## Machine-readable resources\n\n- [OpenAPI](${origin}/openapi.json): Public read-only content endpoints only.\n- [Project schema](${origin}/schema/paperplane.json): JSON Schema for paperplane.json.\n- [Sitemap](${origin}/sitemap.xml): Public content URLs, excluding private app routes.\n\n## Optional\n\n- [Source](https://github.com/getpaperplane/paperplane): Code and issue tracker.\n`,
    "robots.txt": `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`,
    "sitemap.xml": `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${["/", "/docs"].map((path) => `  <url><loc>${escapeHtml(origin + path)}</loc></url>`).join("\n")}\n</urlset>\n`,
    "openapi.json": `${JSON.stringify(openApiDocument(origin), null, 2)}\n`,
  };
}

function openApiDocument(origin: string) {
  const errorContent = {
    "application/json": { schema: { $ref: "#/components/schemas/Error" } },
    "text/markdown": { schema: { type: "string" } },
    "text/html": { schema: { type: "string" } },
  };
  const resource = (summary: string, types: string[]) => ({
    get: {
      summary,
      responses: {
        200: {
          description: "Public content",
          content: Object.fromEntries(types.map((type) => [type, { schema: { type: "string" } }])),
        },
        406: {
          description: "No acceptable representation; request one of the listed media types.",
          content: errorContent,
        },
      },
    },
  });
  return {
    openapi: "3.1.1",
    info: {
      title: "Paperplane hosted content",
      version: "1.0.0",
      description:
        "Public read-only content on the hosted browser app. No repository, terminal, pairing, or agent execution API is provided here. Paired environments use a separate authenticated WebSocket protocol. GET resources also support HEAD; other methods return 405 with Allow: GET, HEAD. Unknown resources return 404, negotiated as HTML, Markdown, or JSON. /api paths always return structured JSON errors.",
    },
    servers: [{ url: origin }],
    paths: {
      "/": resource("Product overview (interactive browser app in HTML)", [
        "text/html",
        "text/markdown",
      ]),
      "/docs": resource("Connection and API boundary guide", ["text/html", "text/markdown"]),
      "/index.md": resource("Overview in Markdown", ["text/markdown"]),
      "/docs.md": resource("Connection guide in Markdown", ["text/markdown"]),
      "/llms.txt": resource("Agent resource directory", ["text/plain"]),
      "/robots.txt": resource("Crawler policy", ["text/plain"]),
      "/sitemap.xml": resource("Public content sitemap", ["application/xml"]),
      "/openapi.json": {
        get: {
          summary: "This OpenAPI document",
          responses: {
            200: {
              description: "OpenAPI 3.1.1 document",
              content: { "application/json": { schema: { type: "object" } } },
            },
            406: { description: "Request application/json.", content: errorContent },
          },
        },
      },
      "/schema/paperplane.json": {
        get: {
          summary: "paperplane.json project configuration schema",
          responses: {
            200: {
              description: "JSON Schema",
              content: {
                "application/schema+json": { schema: { type: "object" } },
                "application/json": { schema: { type: "object" } },
              },
            },
            406: {
              description: "Request application/json or application/schema+json.",
              content: errorContent,
            },
          },
        },
      },
      "/api": {
        get: {
          summary: "Explain the hosted API boundary",
          responses: {
            404: {
              description: "Use your own paired Paperplane environment instead.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message", "hint", "docs"],
              properties: {
                code: {
                  type: "string",
                  enum: ["NOT_FOUND", "HOST_REQUIRED", "METHOD_NOT_ALLOWED", "NOT_ACCEPTABLE"],
                },
                message: { type: "string" },
                hint: { type: "string" },
                docs: { type: "string", format: "uri-reference" },
              },
            },
          },
        },
      },
    },
  };
}
