import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";
import { afterEach, it, vi } from "vite-plus/test";

import {
  cloudflarePreviewRequest,
  previewDeployment,
  previewWorkerName,
} from "./cloudflare-web-preview.mjs";
import { hostedBuildDefines } from "../apps/web/vite/hostedBuild.ts";
import { workerFirstPaths } from "../apps/web/cloudflare/worker.mjs";

afterEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllEnvs());

it("builds an isolated Worker configuration using only the trusted edge handler and assets", () => {
  const deployment = previewDeployment(
    42,
    "paperplane-test",
    {
      name: "paperplane-web",
      compatibility_date: "2025-04-01",
      routes: [{ pattern: "rove.hafiezulzikry.com", custom_domain: true }],
      workers_dev: false,
      main: "production-server.js",
      vars: { SECRET: "production-only" },
      kv_namespaces: [{ binding: "PRODUCTION" }],
    },
    "/tmp/preview/dist",
  );
  NodeAssert.equal(deployment.origin, "https://paperplane-web-pr-42.paperplane-test.workers.dev");
  NodeAssert.equal(deployment.config.name, "paperplane-web-pr-42");
  NodeAssert.equal(deployment.config.assets.directory, NodePath.resolve("/tmp/preview/dist"));
  NodeAssert.equal(deployment.config.main, NodePath.resolve("apps/web/cloudflare/worker.mjs"));
  NodeAssert.equal(deployment.config.assets.binding, "ASSETS");
  NodeAssert.equal(deployment.config.assets.not_found_handling, "none");
  NodeAssert.equal(deployment.config.assets.html_handling, "none");
  NodeAssert.deepEqual(deployment.config.assets.run_worker_first, workerFirstPaths);
  for (const key of ["routes", "vars", "kv_namespaces"]) {
    NodeAssert.equal(key in deployment.config, false);
  }
  const defines = hostedBuildDefines(deployment.origin);
  NodeAssert.equal(JSON.parse(defines["import.meta.env.VITE_HOSTED_APP_URL"]), deployment.origin);
  NodeAssert.equal(JSON.parse(defines["import.meta.env.VITE_PAPERPLANE_RELAY_URL"]), "");
});

it("gives each PR a stable origin without sharing Workers", () => {
  const first = previewDeployment(1, "paperplane", {}, ".");
  NodeAssert.deepEqual(first, previewDeployment(1, "paperplane", {}, "."));
  NodeAssert.notEqual(first.origin, previewDeployment(2, "paperplane", {}, ".").origin);
});

it.each([0, -1, "../paperplane-web", "1\nname=paperplane-web"])(
  "rejects unsafe preview names %s",
  (prNumber) => {
    NodeAssert.throws(() => previewWorkerName(prNumber));
  },
);

it.each(["", "paperplane.example.com", "paperplane\nVITE_HTTP_URL=bad"])(
  "rejects unsafe workers.dev subdomains %s",
  (subdomain) => {
    NodeAssert.throws(() => previewDeployment(1, subdomain, {}, "."));
  },
);

it("treats deletion of an absent preview as complete", async () => {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account-fixture");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token-fixture");
  vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
  NodeAssert.equal(
    await cloudflarePreviewRequest("workers/scripts/paperplane-web-pr-42", "DELETE"),
    undefined,
  );
});

it("does not mistake permission errors for a completed cleanup", async () => {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account-fixture");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token-fixture");
  vi.stubGlobal("fetch", async () =>
    Response.json({ success: false, errors: [{ message: "Denied" }] }, { status: 403 }),
  );
  await NodeAssert.rejects(
    cloudflarePreviewRequest("workers/scripts/paperplane-web-pr-42", "DELETE"),
    /HTTP 403/,
  );
});
