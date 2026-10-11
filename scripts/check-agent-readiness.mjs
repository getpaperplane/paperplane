import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export function checkHomepageHtml(html) {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? "";
  const text = body
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  NodeAssert.ok(text.length >= 500, `Raw homepage text is too short (${text.length} characters).`);
  const headings = [...body.matchAll(/<h([1-6])\b/gi)].map((match) => Number(match[1]));
  NodeAssert.equal(headings.filter((level) => level === 1).length, 1, "Expected one clear H1.");
  NodeAssert.equal(headings[0], 1);
  for (let index = 1; index < headings.length; index++) {
    NodeAssert.ok(headings[index] <= headings[index - 1] + 1, "Heading levels must not skip.");
  }
  return text.length;
}

export async function checkAgentReadiness(origin) {
  async function request(path, accept, status, type, vary = true, method = "GET") {
    const response = await fetch(new URL(path, origin), {
      headers: { Accept: accept },
      method,
      signal: AbortSignal.timeout(10_000),
    });
    NodeAssert.equal(response.status, status, `${method} ${path} (${accept}) status`);
    NodeAssert.equal(
      response.headers.get("content-type")?.split(";")[0],
      type,
      `${path} Content-Type`,
    );
    if (vary)
      NodeAssert.match(
        response.headers.get("vary") ?? "",
        /(?:^|,\s*)Accept(?:,|$)/i,
        `${path} Vary`,
      );
    return { response, body: await response.text() };
  }
  const html = await request("/", "text/html", 200, "text/html");
  const characters = checkHomepageHtml(html.body);
  const markdown = await request("/", "text/markdown", 200, "text/markdown");
  NodeAssert.match(markdown.body, /^# Rove Code/);
  NodeAssert.ok(markdown.body.length >= 500);
  await request("/", "text/html;q=0.2, text/markdown;q=0.9", 200, "text/markdown");
  await request("/", "text/markdown;q=0, text/*;q=1", 200, "text/html");
  await request("/", "image/png", 406, "application/json");
  const head = await request("/", "text/markdown", 200, "text/markdown", true, "HEAD");
  NodeAssert.equal(head.body, "");
  for (const [path, type] of [
    ["/index.md", "text/markdown"],
    ["/docs.md", "text/markdown"],
    ["/llms.txt", "text/plain"],
    ["/robots.txt", "text/plain"],
    ["/sitemap.xml", "application/xml"],
    ["/openapi.json", "application/json"],
    ["/schema/rove.json", "application/schema+json"],
  ]) {
    const { body } = await request(path, type, 200, type);
    NodeAssert.ok(body.length > 20, `${path} content`);
    if (path.endsWith(".json")) {
      const value = JSON.parse(body);
      if (path === "/openapi.json") {
        NodeAssert.equal(value.openapi, "3.1.1");
        NodeAssert.equal(value.servers[0].url, new URL(origin).origin);
        NodeAssert.ok(value.paths["/"]?.get?.responses["200"]?.content["text/markdown"]);
      } else NodeAssert.equal(value.type, "object");
    }
    if (path === "/llms.txt") NodeAssert.match(body, /^# Rove Code\n\n> /);
    if (path === "/robots.txt")
      NodeAssert.ok(body.includes(`Sitemap: ${new URL("/sitemap.xml", origin)}`));
    if (path === "/sitemap.xml")
      NodeAssert.match(body, /xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9"/);
  }
  for (const type of ["text/html", "text/markdown"]) {
    const { body } = await request("/docs", type, 200, type);
    NodeAssert.ok(body.includes("Connect to Rove Code"));
  }
  for (const path of [
    "/some-path-that-does-not-exist",
    "/assets/missing.js",
    "/docs/missing",
    "/settings/missing",
  ]) {
    const { body } = await request(path, "text/markdown", 404, "text/markdown");
    NodeAssert.ok(body.length >= 20 && body.includes("/llms.txt"), `${path} error guidance`);
  }
  for (const path of ["/api", "/api/missing"]) {
    const { body } = await request(path, "text/html", 404, "application/json");
    const error = JSON.parse(body).error;
    NodeAssert.equal(error.code, "HOST_REQUIRED");
    for (const field of ["message", "hint", "docs"]) NodeAssert.ok(error[field].length > 0);
  }
  const missingJson = await request("/missing", "application/json", 404, "application/json");
  NodeAssert.equal(JSON.parse(missingJson.body).error.code, "NOT_FOUND");
  const method = await request("/", "application/json", 405, "application/json", true, "POST");
  NodeAssert.equal(method.response.headers.get("allow"), "GET, HEAD");
  for (const path of [
    "/welcome",
    "/connect",
    "/pair?code=verification-only",
    "/settings/connections",
    "/draft/verification",
    "/projects/environment%3Aproject",
    "/environment/thread",
  ]) {
    const { body } = await request(path, "text/html", 200, "text/html", false);
    NodeAssert.ok(body.includes('id="root"'), `${path} app shell`);
  }
  return { characters };
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  NodeAssert.ok(process.argv[2], "Usage: node scripts/check-agent-readiness.mjs <origin>");
  const result = await checkAgentReadiness(process.argv[2]);
  console.log(`Agent readiness endpoints verified (${result.characters} raw homepage characters).`);
}
