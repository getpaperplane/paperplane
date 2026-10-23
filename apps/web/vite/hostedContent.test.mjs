import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterAll, beforeAll, it } from "vite-plus/test";
import { build } from "vite-plus";
import { JSDOM } from "jsdom";
import { hostedContentPlugin } from "./hostedContent.ts";
import { projectFileSchemaPlugin } from "./projectFileSchema.ts";
import worker, {
  appRoutes,
  isAppRoute,
  negotiate,
  workerFirstPaths,
} from "../cloudflare/worker.mjs";
import { checkAgentReadiness, checkHomepageHtml } from "../../../scripts/check-agent-readiness.mjs";

const webDirectory = NodeURL.fileURLToPath(new URL("../", import.meta.url));
let root;
let server;
let origin;
let env;
let html;

beforeAll(async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "rove-agent-readiness-"));
  server = NodeHttp.createServer(async (request, response) => {
    try {
      const result = await worker.fetch(
        new Request(new URL(request.url, origin), {
          method: request.method,
          headers: request.headers,
        }),
        env,
      );
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  server.listen(0, "127.0.0.1");
  await NodeEvents.once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  const source = await NodeFSP.readFile(NodePath.join(webDirectory, "index.html"), "utf8");
  await NodeFSP.writeFile(
    NodePath.join(root, "index.html"),
    source.replace("/src/bootstrap.ts", "/bootstrap.js"),
  );
  await NodeFSP.writeFile(NodePath.join(root, "bootstrap.js"), "window.testBoot = true;");
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [hostedContentPlugin(origin), projectFileSchemaPlugin()],
  });
  html = await NodeFSP.readFile(NodePath.join(root, "dist/index.html"), "utf8");
  env = {
    ASSETS: {
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        try {
          const body = await NodeFSP.readFile(NodePath.join(root, "dist", pathname));
          const type = pathname.endsWith(".html")
            ? "text/html"
            : pathname.endsWith(".json")
              ? "application/json"
              : "text/plain";
          return new Response(request.method === "HEAD" ? null : body, {
            headers: { "Content-Type": type, Vary: "Accept-Encoding", ETag: `"${pathname}"` },
          });
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error;
          return new Response(null, { status: 404 });
        }
      },
    },
  };
});

afterAll(async () => {
  if (server) {
    server.close();
    await NodeEvents.once(server, "close");
  }
  if (root) await NodeFSP.rm(root, { recursive: true, force: true });
});

it("verifies every public endpoint through HTTP using real build assets", async () => {
  const result = await checkAgentReadiness(origin);
  NodeAssert.ok(result.characters >= 500);
});

it("offers a meaningful no-JavaScript overview but keeps the original JS splash", () => {
  const noScript = new JSDOM(html);
  NodeAssert.ok(
    noScript.window.document.querySelector("#hosted-overview").textContent.length > 500,
  );
  NodeAssert.equal(noScript.window.document.querySelectorAll("h1").length, 1);
  const withScript = new JSDOM(html, { runScripts: "dangerously" });
  NodeAssert.equal(withScript.window.document.querySelector("#hosted-overview"), null);
  NodeAssert.ok(withScript.window.document.querySelector("#boot-shell-logo"));
  noScript.window.close();
  withScript.window.close();
});

it("routes negotiable content through the Worker while leaving existing assets asset-first", async () => {
  for (const filename of ["wrangler.json", "wrangler.nightly.json"]) {
    const config = JSON.parse(
      await NodeFSP.readFile(NodePath.join(webDirectory, filename), "utf8"),
    );
    NodeAssert.equal(config.assets.not_found_handling, "none");
    NodeAssert.equal(config.assets.html_handling, "none");
    NodeAssert.equal(config.assets.binding, "ASSETS");
    NodeAssert.deepEqual(config.assets.run_worker_first, workerFirstPaths);
    NodeAssert.ok(
      !config.assets.run_worker_first.some(
        (path) => path.includes("assets") || path.startsWith("!"),
      ),
    );
  }
});

it("does not allow missing content namespaces to become thread routes", async () => {
  for (const path of [
    "/bogus",
    "/bogus/path/deeper",
    "/settings/bogus",
    "/docs/bogus",
    "/assets/bogus.js",
    "/.well-known/rove",
    "/oauth/callback",
  ]) {
    NodeAssert.equal(isAppRoute(path), false, path);
    const response = await worker.fetch(
      new Request(new URL(path, origin), { headers: { Accept: "text/markdown" } }),
      env,
    );
    NodeAssert.equal(response.status, 404, path);
  }
});

it("keeps hosted deep links in step with the actual router", async () => {
  const tree = await NodeFSP.readFile(NodePath.join(webDirectory, "src/routeTree.gen.ts"), "utf8");
  const routes = [
    ...tree
      .split("export interface FileRoutesByFullPath {")[1]
      .split("}\n")[0]
      .matchAll(/'([^']+)':/g),
  ].map((match) => match[1]);
  NodeAssert.deepEqual([...appRoutes].sort(), routes.sort());
  for (const route of routes) {
    const path = route.replace(/\$[a-zA-Z]+/g, "test-id");
    NodeAssert.ok(isAppRoute(path), path);
    const response = await worker.fetch(new Request(new URL(`${path}?preserved=1`, origin)), env);
    NodeAssert.equal(response.status, 200, path);
  }
});

it("preserves non-UUID identifiers accepted by paired environments", async () => {
  for (const path of [
    "/environment.custom/thread.custom",
    "/projects/environment%3Aproject.custom",
    "/draft/custom.draft",
  ]) {
    NodeAssert.ok(isAppRoute(path));
    const response = await worker.fetch(new Request(new URL(path, origin)), env);
    NodeAssert.equal(response.status, 200);
  }
});

it("keeps ordinary assets, validators, and Vary headers intact", async () => {
  const response = await worker.fetch(new Request(new URL("/index.md", origin)), env);
  NodeAssert.equal(response.headers.get("etag"), '"/index.md"');
  NodeAssert.equal(response.headers.get("vary"), "Accept-Encoding, Accept");
  const assets = await NodeFSP.readdir(NodePath.join(root, "dist/assets"));
  const asset = await worker.fetch(new Request(new URL(`/assets/${assets[0]}`, origin)), env);
  NodeAssert.equal(asset.status, 200);
  NodeAssert.equal(asset.headers.get("vary"), "Accept-Encoding");
});

it("returns JSON errors on API subpaths even for POST and HTML Accept", async () => {
  const response = await worker.fetch(
    new Request(new URL("/api/turns", origin), {
      method: "POST",
      headers: { Accept: "text/html" },
    }),
    env,
  );
  NodeAssert.equal(response.status, 404);
  NodeAssert.match(response.headers.get("content-type"), /^application\/json/);
  NodeAssert.equal((await response.json()).error.code, "HOST_REQUIRED");
});

it("returns explanatory HTML and bodyless HEAD errors", async () => {
  const missing = await worker.fetch(new Request(new URL("/missing", origin)), env);
  NodeAssert.equal(missing.status, 404);
  NodeAssert.match(await missing.text(), /<h1>404/);
  const head = await worker.fetch(
    new Request(new URL("/missing", origin), {
      method: "HEAD",
      headers: { Accept: "text/markdown" },
    }),
    env,
  );
  NodeAssert.equal(head.status, 404);
  NodeAssert.equal(await head.text(), "");
});

it("rejects insufficient or poorly headed raw HTML", () => {
  NodeAssert.throws(() =>
    checkHomepageHtml("<body><h1>Paperplane</h1><script>" + "x".repeat(600) + "</script></body>"),
  );
  NodeAssert.throws(() =>
    checkHomepageHtml(`<body><h1>Paperplane</h1><h3>Skipped</h3><p>${"content ".repeat(100)}</p></body>`),
  );
});

it("publishes valid discovery formats and resolves every OpenAPI schema reference", async () => {
  const spec = JSON.parse(await NodeFSP.readFile(NodePath.join(root, "dist/openapi.json"), "utf8"));
  NodeAssert.equal(spec.openapi, "3.1.1");
  NodeAssert.ok(spec.info.title && spec.info.version);
  for (const path of Object.keys(spec.paths)) {
    const response = await worker.fetch(new Request(new URL(path, origin)), env);
    NodeAssert.equal(response.status, path === "/api" ? 404 : 200);
  }
  function resolveReferences(value) {
    // Walking a parsed JSON document requires distinguishing objects from scalar values.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    if (!value || typeof value !== "object") return;
    if (value.$ref) {
      NodeAssert.ok(value.$ref.startsWith("#/"));
      NodeAssert.ok(
        value.$ref
          .slice(2)
          .split("/")
          .reduce((target, key) => target[key], spec),
      );
    }
    for (const child of Object.values(value)) resolveReferences(child);
  }
  resolveReferences(spec);
  const sitemap = new JSDOM(
    await NodeFSP.readFile(NodePath.join(root, "dist/sitemap.xml"), "utf8"),
    { contentType: "application/xml" },
  );
  NodeAssert.deepEqual(
    [...sitemap.window.document.querySelectorAll("loc")].map((loc) => loc.textContent),
    [origin + "/", origin + "/docs"],
  );
  sitemap.window.close();
  const llms = await NodeFSP.readFile(NodePath.join(root, "dist/llms.txt"), "utf8");
  for (const match of llms.matchAll(/\]\(([^)]+)\)/g)) {
    const url = new URL(match[1]);
    if (url.origin === origin)
      NodeAssert.equal((await worker.fetch(new Request(url), env)).status, 200);
  }
});

it.each([
  [null, "text/html"],
  ["*/*", "text/html"],
  ["text/markdown", "text/markdown"],
  ["TEXT/MARKDOWN", "text/markdown"],
  ["text/*", "text/html"],
  ["text/markdown;q=0, */*;q=1", "text/html"],
  ["text/html;q=0, text/markdown;q=0, */*;q=1", undefined],
  ["text/html;q=0.1, text/markdown;q=0.8", "text/markdown"],
  ["text/html;q=1, text/markdown;q=0.8", "text/html"],
  ["text/html;q=0.5, text/*;q=1", "text/markdown"],
  ["image/png", undefined],
  ["", undefined],
  ["text/markdown;q=bad", undefined],
  ['text/markdown;charset="UTF-8"', "text/markdown"],
  ["text/markdown;charset=iso-8859-1", undefined],
  ["text/html;level=1", undefined],
  ["text/html;q=0.9, text/html;charset=utf-8;q=0.1, text/markdown;q=0.5", "text/markdown"],
  ['text/html;profile="comma,value", text/markdown', "text/markdown"],
  ["text/html;q=0.2, text/html;q=0.8, text/markdown;q=0.5", "text/html"],
])("negotiates Accept %s", (accept, expected) => {
  NodeAssert.equal(negotiate(accept, ["text/html", "text/markdown"]), expected);
});
