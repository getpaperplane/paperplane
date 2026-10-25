// @effect-diagnostics nodeBuiltinImport:off - Build assertions stage and bundle real server output.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeSqlite from "node:sqlite";
import { build } from "vite-plus/pack";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import serverPackageJson from "../../apps/server/package.json" with { type: "json" };

import { findEsmImportsOfExternalPackages } from "./cli-executable-imports.ts";
import { runtimePackageClosure } from "./runtime-package-closure.ts";
import { stageRuntimePackageFixture } from "./runtime-package-fixture.ts";

import {
  CLI_PI_RUNTIME_PACKAGES,
  isExternalCliDependency,
  isRuntimeExternalCliDependency,
  findInlinedExternalPackages,
  selectCliRuntimeExternalDependencies,
  shouldBundleCliDependency,
} from "./cli-external-packages.ts";

// Only the field this test cares about; decoding ignores everything else.
// optionalDependencies matter as much as dependencies here: every native family
// in the list declares its actual platform bindings there (ffi-rs -> @yuuang/*,
// fff-node -> @ff-labs/fff-bin-*), so reading only `dependencies` would check
// nothing for exactly those packages.
const PackageManifest = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
type PackageManifest = typeof PackageManifest.Type;
interface InstalledPackage {
  readonly manifest: PackageManifest;
  readonly directory: string;
  readonly storeEntry: string;
}

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(PackageManifest));

const serverRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../apps/server",
);

describe("shouldBundleCliDependency", () => {
  it("bundles ordinary runtime dependencies", () => {
    for (const id of ["effect", "@effect/platform", "@getpaperplane/shared/HostProcess"]) {
      assert.strictEqual(shouldBundleCliDependency(id), true, id);
    }
  });

  it("never bundles node: builtins", () => {
    assert.strictEqual(shouldBundleCliDependency("node:fs"), false);
  });

  it("leaves native addons and their dlopen wrappers external", () => {
    for (const id of [
      "node-pty",
      "ffi-rs",
      "@yuuang/ffi-rs-win32-x64-msvc",
      "@ff-labs/fff-node",
      "@napi-rs/keyring",
      "@clerk/electron-passkeys",
      "node-addon-api",
      "cbor-x",
      "cbor-extract",
      "@cbor-extract/cbor-extract-linux-x64",
      "@cbor-extract/cbor-extract-win32-x64",
      "detect-libc",
    ]) {
      assert.strictEqual(shouldBundleCliDependency(id), false, id);
    }
  });

  it("keeps Pi's SDK and child runtime dependencies on disk", () => {
    for (const name of [
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-coding-agent/rpc-entry",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-codemode",
      "@earendil-works/pi-mcp",
      "jiti",
      "typebox/compile",
      // Pi's @google/genai optional peer is externalized even though a clean
      // production install only includes it when Paperplane declares it directly.
      "@modelcontextprotocol/sdk/client/index.js",
      "@modelcontextprotocol/sdk/client/streamableHttp.js",
      "@modelcontextprotocol/sdk/client/stdio.js",
    ]) {
      assert.strictEqual(shouldBundleCliDependency(name), false, name);
    }
    assert.strictEqual(shouldBundleCliDependency("jiti-unrelated"), true);
  });

  // An external bare import must resolve from the repo checkout, or dev
  // `start:desktop` crashes the backend with ERR_MODULE_NOT_FOUND. The
  // packaged app stages every external next to the bundle, but dev runs
  // the bundle straight from the repo, where transitive-only packages have
  // no top-level link. Regression: `ws` (via @effect/platform-node-shared)
  // went external with the Pi runtime closure while nothing declared it,
  // so the desktop backend exited code=1 in a restart loop.
  it("resolves every external bare import of the server bundle from the repo", () => {
    const externals = ["ws", "jose", "cross-spawn", "cbor-x", "@modelcontextprotocol/sdk"];
    for (const name of externals) {
      assert.strictEqual(shouldBundleCliDependency(name), false, name);
      if (name !== "cbor-x") {
        assert.ok(
          CLI_PI_RUNTIME_PACKAGES.includes(name),
          `expected ${name} in the Pi runtime closure`,
        );
      }
    }
    // SAFETY: apps/server/package.json is repo-controlled and always parses
    // to an object; only its optional dependencies map is read.
    const serverManifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(serverRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    for (const name of externals) {
      assert.ok(
        serverManifest.dependencies?.[name] !== undefined,
        `expected apps/server dependency "${name}" so pnpm links it for dev; ` +
          `external bundle imports only resolve from the real filesystem`,
      );
    }
  });

  it("leaves bun-only entry points external", () => {
    assert.strictEqual(shouldBundleCliDependency("@effect/platform-bun"), false);
    assert.strictEqual(shouldBundleCliDependency("@effect/sql-sqlite-bun"), false);
  });

  // The real package is `node-gyp-build-optional-packages`, reached by prefix.
  // It is transitive to a selected dependency root, so the runtime closure test
  // below ensures it follows that root into the sidecar.
  it("treats prefix-matched siblings as external", () => {
    assert.strictEqual(shouldBundleCliDependency("node-gyp-build-optional-packages"), false);
  });
});

describe("selectCliRuntimeExternalDependencies", () => {
  it("keeps only runtime-external dependency roots for the Windows sidecar", () => {
    assert.deepStrictEqual(
      selectCliRuntimeExternalDependencies({
        "@ff-labs/fff-node": "2.0.0",
        effect: "3.0.0",
        "node-pty": "4.0.0",
      }),
      {
        "@ff-labs/fff-node": "2.0.0",
        "node-pty": "4.0.0",
      },
    );
  });

  it("selects every external root declared by the server", () => {
    assert.deepStrictEqual(
      Object.keys(selectCliRuntimeExternalDependencies(serverPackageJson.dependencies)).sort(),
      [
        "@cursor/sdk",
        "@earendil-works/pi-ai",
        "@earendil-works/pi-coding-agent",
        "@ff-labs/fff-node",
        "@modelcontextprotocol/sdk",
        "@napi-rs/keyring",
        "cbor-x",
        "cross-spawn",
        "ffi-rs",
        "jose",
        "node-pty",
        "playwright-core",
        "proper-lockfile",
        "undici",
        "ws",
        "yaml",
      ],
    );
  });
});

// An external package is loaded from the real filesystem, so its own `require`
// also resolves from the real filesystem. If one of its dependencies was
// bundled away instead of left external, that dependency does not follow the
// selected root into the sidecar.
//
// Found the hard way: msgpackr-extract's node-gyp-build-optional-packages
// required detect-libc, which was bundled. Windows was fine; WSL got
// MODULE_NOT_FOUND.
it.layer(NodeServices.layer)("external package dependency closure", (it) => {
  // Read manifests off disk from the pnpm store rather than resolving them.
  // `require("<name>/package.json")` cannot do this job: under pnpm isolation a
  // transitive package (node-addon-api, ffi-rs) is not reachable
  // by name from this file at all, and an `exports` map can refuse the
  // `/package.json` subpath outright (@ff-labs/fff-node). Both surface as "not
  // installed", which would let this test skip everything and pass while
  // checking nothing. The store contains the dependency graph the sidecar's
  // minimal production install resolves.
  const readInstalledPackages = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const storeDir = path.resolve(
      path.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "../../node_modules/.pnpm",
    );

    // The store holds regular files too (lock.yaml), so a path built under one
    // raises ENOTDIR rather than reporting absence. That throws on Linux while
    // Windows quietly returns false, which is exactly the kind of difference
    // this test exists to catch, so treat any failure as "not there".
    const isPresent = (candidate: string) =>
      fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));

    const installed = new Map<string, InstalledPackage>();
    if (!(yield* isPresent(storeDir))) return installed;

    for (const entry of yield* fileSystem.readDirectory(storeDir)) {
      const modulesDir = path.join(storeDir, entry, "node_modules");
      if (!(yield* isPresent(modulesDir))) continue;

      for (const owner of yield* fileSystem.readDirectory(modulesDir)) {
        const names = owner.startsWith("@")
          ? (yield* fileSystem.readDirectory(path.join(modulesDir, owner))).map(
              (scoped) => `${owner}/${scoped}`,
            )
          : [owner];

        for (const name of names) {
          if (installed.has(name)) continue;
          const manifestPath = path.join(modulesDir, name, "package.json");
          if (!(yield* isPresent(manifestPath))) continue;
          installed.set(name, {
            manifest: decodeManifest(yield* fileSystem.readFileString(manifestPath)),
            directory: path.join(modulesDir, name),
            storeEntry: entry,
          });
        }
      }
    }
    return installed;
  }).pipe(Effect.cached, Effect.runSync);

  // Runtime-external only. The build-only entries resolve `bun:*` and are never
  // loaded by Node, so their closure genuinely does not need to be external.
  const isRuntimeExternal = isRuntimeExternalCliDependency;

  // A cold walk of the pnpm store can exceed the root timeout when the Windows
  // lane runs four filesystem-heavy workspace suites at once.
  it.effect(
    "finds the runtime-external packages on disk",
    () =>
      Effect.gen(function* () {
        const installed = yield* readInstalledPackages;
        const found = [...installed.keys()].filter(isRuntimeExternal);

        // Without this the closure check below can pass vacuously: if nothing is
        // read, nothing is checked. node-pty is the one native root every
        // platform ships, and node-addon-api is its transitive runtime
        // dependency, so require them by name.
        for (const required of ["node-pty", "node-addon-api"]) {
          assert.ok(
            found.includes(required),
            `expected ${required} in the pnpm store; the closure check is only meaningful if it can read these (found ${found.length})`,
          );
        }
      }),
    120_000,
  );

  it.effect("keeps every resolvable runtime dependency of an external package external too", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const installed = yield* readInstalledPackages;
      const storeDir = path.resolve(
        path.dirname(NodeURL.fileURLToPath(import.meta.url)),
        "../../node_modules/.pnpm",
      );
      const resolveFrom = (entry: InstalledPackage, name: string) => {
        // pnpm links one package directory per dependent; a manifest that names
        // an unlinked dependency cannot load it. The installed map is keyed by
        // name, so resolve from the dependent's own store entry instead.
        const scoped = name.split("/");
        const owner =
          scoped.length > 1 && scoped[0]?.startsWith("@")
            ? [scoped[0], scoped[1]].join("/")
            : scoped[0];
        if (owner === undefined) return undefined;
        const candidate = path.join(storeDir, entry.storeEntry, "node_modules", owner);
        return NodeFS.existsSync(path.join(candidate, "package.json")) ? candidate : undefined;
      };
      const violations: string[] = [];
      const seen = new Set<string>();
      // Seeded from what is actually installed and matches a prefix, so scoped
      // prefixes like "@yuuang/" and "@ff-labs/" are covered too. Seeding from
      // the prefix strings themselves would skip every scoped entry, since a
      // prefix is not a package name.
      const queue = [...installed.keys()].filter(isRuntimeExternal);

      for (const name of queue) {
        if (seen.has(name)) continue;
        seen.add(name);

        const entry = installed.get(name);
        if (!entry) continue;

        const declared = {
          ...entry.manifest.dependencies,
          ...entry.manifest.optionalDependencies,
        };
        for (const dependency of Object.keys(declared)) {
          // Only violations from an external package have the WSL loader
          // meaning this test guards. Pi's own copies stay external by the Pi
          // list, but their transitive needs ship inside the Pi runtime
          // instead; checking the legacy closure there cannot fail a machine.
          if (CLI_PI_RUNTIME_PACKAGES.includes(name)) continue;
          // Manifests name fallbacks and rename targets that the dependent
          // package cannot load in the deployed externas layout. Only a name
          // resolvable from the dependent copy itself can fail at runtime.
          if (resolveFrom(entry, dependency) === undefined) continue;
          if (!isRuntimeExternal(dependency)) {
            violations.push(`${name} -> ${dependency}`);
          }
          if (!seen.has(dependency)) queue.push(dependency);
        }
      }

      assert.deepStrictEqual(
        violations,
        [],
        `these dependencies of external packages would be bundled away and fail to resolve under WSL: ${violations.join(", ")}`,
      );
    }),
  );
});

// Configuring the bundler is not the same as checking what it emitted. These
// exercise the scanner against the marker shape rolldown actually produces.
describe("findInlinedExternalPackages", () => {
  const region = (path: string) => `//#region ${path}
var x = 1;
//#endregion
`;

  it("flags an external package that was inlined", () => {
    const source =
      region("../../node_modules/.pnpm/node-addon-api@7.1.1/node_modules/node-addon-api/index.js") +
      region(
        "../../node_modules/.pnpm/node-gyp-build-optional-packages@5.2.2/node_modules/node-gyp-build-optional-packages/index.js",
      );
    const result = findInlinedExternalPackages(source);

    assert.deepStrictEqual(result.inlined, ["node-addon-api", "node-gyp-build-optional-packages"]);
    assert.strictEqual(result.regionCount, 2);
  });

  it("flags scoped external packages", () => {
    const result = findInlinedExternalPackages(
      region("../../node_modules/@ff-labs/fff-node/dist/src/index.js"),
    );
    assert.deepStrictEqual(result.inlined, ["@ff-labs/fff-node"]);
  });

  it("does not treat bundled package manifests as runtime code", () => {
    const source =
      region("../../node_modules/@earendil-works/pi-coding-agent/package.json") +
      region("../../node_modules/node-pty/package.json");
    const result = findInlinedExternalPackages(source);

    assert.strictEqual(result.regionCount, 2);
    assert.deepStrictEqual(result.inlined, []);
    assert.deepStrictEqual(result.inlinedPackages, []);
  });

  it("still flags runtime code alongside a bundled manifest", () => {
    const source =
      region("../../node_modules/@earendil-works/pi-coding-agent/package.json") +
      region("../../node_modules/@earendil-works/pi-coding-agent/dist/index.js");
    const result = findInlinedExternalPackages(source);

    assert.strictEqual(result.regionCount, 2);
    assert.deepStrictEqual(result.inlined, ["@earendil-works/pi-coding-agent"]);
    assert.deepStrictEqual(result.inlinedPackages, ["@earendil-works/pi-coding-agent"]);
  });

  it("does not count a manifest as proof of a self-contained runtime", () => {
    const result = findInlinedExternalPackages(
      region("../../node_modules/.pnpm/effect@4.0.0/node_modules/effect/package.json"),
    );

    assert.strictEqual(result.regionCount, 1);
    assert.deepStrictEqual(result.inlinedPackages, []);
  });

  it("ignores packages that are meant to be bundled", () => {
    const source =
      region("../../node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/index.js") +
      region("../../src/server/main.ts");
    const result = findInlinedExternalPackages(source);

    assert.deepStrictEqual(result.inlined, []);
    assert.strictEqual(result.regionCount, 2);
  });

  // regionCount is what separates "clean" from "this scan went blind because the
  // marker format changed". A caller that ignores it gets a vacuous pass.
  // The scan has to answer both directions. Checking only that externals are
  // absent still passes on a bundle that externalized everything, which is the
  // failure this whole change prevents.
  it("reports the packages that were inlined, not just the violations", () => {
    const source =
      region("../../node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/index.js") +
      region("../../node_modules/.pnpm/nanoid@5.0.0/node_modules/nanoid/index.js") +
      region("../../src/server/main.ts");
    const result = findInlinedExternalPackages(source);

    assert.deepStrictEqual(result.inlinedPackages, ["effect", "nanoid"]);
    assert.deepStrictEqual(result.inlined, []);
  });

  it("does not report the pnpm store directory as a package", () => {
    const result = findInlinedExternalPackages(
      region("../../node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/index.js"),
    );
    assert.deepStrictEqual(result.inlinedPackages, ["effect"]);
  });

  it("reports no regions when the marker format is absent", () => {
    const result = findInlinedExternalPackages("var x = 1; // node_modules/node-pty/lib.js");
    assert.strictEqual(result.regionCount, 0);
    assert.deepStrictEqual(result.inlined, []);
  });
});

// The single-executable build can only `import` built-ins. A file-backed
// import of an external package passes every bundler check and the regular
// `node dist/bin.mjs` path, then fails inside the executable, so the scan
// reads the emitted module graph instead.
describe("findEsmImportsOfExternalPackages", () => {
  it("flags static and dynamic imports of file-backed packages", () => {
    const source = [
      'import { FileFinder } from "@ff-labs/fff-node";',
      'import * as fs from "fs";',
      'import { createRequire } from "node:module";',
      'const pty = () => import("node-pty");',
      'const data = () => import("@ff-labs/fff-bin-linux-x64-gnu", { with: { type: "json" } });',
      'const lazy = () => import(/* @vite-ignore */ "ffi-rs");',
      'const local = () => import("./chunk-abc.mjs");',
    ].join("\n");

    assert.deepStrictEqual(findEsmImportsOfExternalPackages(source), [
      "@ff-labs/fff-bin-linux-x64-gnu",
      "@ff-labs/fff-node",
      "ffi-rs",
      "node-pty",
    ]);
  });

  it("flags side-effect imports and re-exports too", () => {
    const source = ['import "msgpackr-extract";', 'export { load } from "ffi-rs";'].join("\n");
    assert.deepStrictEqual(findEsmImportsOfExternalPackages(source), [
      "ffi-rs",
      "msgpackr-extract",
    ]);
  });

  it("ignores imports inside generated extension source and comments", () => {
    const source = [
      'const extension = `import { Type } from "typebox";\nimport type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`;',
      '// import "comment-only";',
      "const example = 'import(\"string-only\")';",
      'const interpolated = `source ${import("real-package")}`;',
    ].join("\n");
    assert.deepStrictEqual(findEsmImportsOfExternalPackages(source), ["real-package"]);
  });

  it("allows optional dynamic Bun built-ins but rejects static imports", () => {
    assert.deepStrictEqual(
      findEsmImportsOfExternalPackages('const load = () => import("bun:sqlite");'),
      [],
    );
    assert.deepStrictEqual(
      findEsmImportsOfExternalPackages('import { Database } from "bun:sqlite";'),
      ["bun:sqlite"],
    );
  });

  it("does not mistake createRequire calls for imports", () => {
    const source = 'const { FileFinder } = createRequire(import.meta.url)("@ff-labs/fff-node");';
    assert.deepStrictEqual(findEsmImportsOfExternalPackages(source), []);
  });
});

it("runs home migration from isolated ESM and CommonJS bundles with a native sidecar", async () => {
  const stage = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "paperplane-home-sidecar-"));
  try {
    const entries: string[] = [];
    for (const format of ["esm", "cjs"] as const) {
      const extension = format === "cjs" ? ".cjs" : ".mjs";
      await build({
        entry: {
          homeMigration: NodeURL.fileURLToPath(
            new URL("../../packages/shared/src/homeMigration.ts", import.meta.url),
          ),
        },
        outDir: stage,
        format,
        config: false,
        tsconfig: false,
        dts: false,
        clean: false,
        shims: true,
        logLevel: "silent",
        outExtensions: () => ({ js: extension }),
        // Mirror the CLI bundle (apps/server/vite.config.ts): JS dependencies are
        // compiled in, and only native addons such as ffi-rs stay external.
        deps: {
          alwaysBundle: (id: string) => shouldBundleCliDependency(id),
          neverBundle: (id: string) => isExternalCliDependency(id),
          onlyBundle: false,
        },
      });
      const entry = NodePath.join(stage, `homeMigration${extension}`);
      entries.push(entry);
      // A no-op start works before the native dependency is installed at all.
      const noop = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const {migrateDefaultHome} = await import(process.argv[1]);
         const result = migrateDefaultHome({homeDirectory: process.argv[2]});
         if(result.kind !== 'skipped') throw new Error('expected no-op');`,
          NodeURL.pathToFileURL(entry).href,
          stage,
        ],
        { cwd: stage, encoding: "utf8", timeout: 10_000, env: { ...process.env, NODE_PATH: "" } },
      );
      assert.equal(noop.status, 0, noop.stderr);
    }
    assert.equal(
      selectCliRuntimeExternalDependencies(serverPackageJson.dependencies)["ffi-rs"],
      "^1.3.0",
    );
    stageRuntimePackageFixture(NodePath.join(serverRoot, "node_modules/ffi-rs"), stage);
    for (const [index, entry] of entries.entries()) {
      const home = NodePath.join(stage, `user-${index}`);
      const state = NodePath.join(home, ".rove-code", "userdata");
      NodeFS.mkdirSync(state, { recursive: true });
      const db = new NodeSqlite.DatabaseSync(NodePath.join(state, "state.sqlite"));
      db.exec("CREATE TABLE messages(text); INSERT INTO messages VALUES ('sidecar snapshot');");
      db.close();
      const child = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import * as sqlite from 'node:sqlite'; import * as path from 'node:path';
         const {migrateDefaultHome} = await import(process.argv[1]);
         const result = migrateDefaultHome({homeDirectory: process.argv[2], log: () => {}});
         if(result.kind !== 'migrated') throw new Error('expected migration');
         const db = new sqlite.DatabaseSync(path.join(process.argv[2], '.paperplane', 'userdata', 'state.sqlite'), {readOnly:true});
         if(db.prepare('SELECT text FROM messages').get().text !== 'sidecar snapshot') throw new Error('snapshot lost data');
         db.close();`,
          NodeURL.pathToFileURL(entry).href,
          home,
        ],
        { cwd: stage, encoding: "utf8", timeout: 10_000, env: { ...process.env, NODE_PATH: "" } },
      );
      assert.equal(child.status, 0, child.stderr);
    }
  } finally {
    NodeFS.rmSync(stage, { recursive: true, force: true });
  }
});

it("loads Paperplane's MCP clients from an isolated runtime sidecar", () => {
  const selected = selectCliRuntimeExternalDependencies(serverPackageJson.dependencies);
  assert.strictEqual(selected["@modelcontextprotocol/sdk"], "1.29.0");
  const stage = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "paperplane-mcp-sidecar-"));
  try {
    const closure = runtimePackageClosure(
      NodePath.join(serverRoot, "node_modules/@modelcontextprotocol/sdk"),
    );
    assert.isAtLeast(closure.size, 1);
    for (const [directory, { name }] of closure) {
      NodeFS.cpSync(directory, NodePath.join(stage, "node_modules", name), { recursive: true });
    }
    const loaded = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "-e",
        'const assert = require("node:assert/strict"); ' +
          'for (const [path, name] of [["index", "Client"], ["streamableHttp", "StreamableHTTPClientTransport"], ["stdio", "StdioClientTransport"]]) ' +
          'assert.equal(typeof require(`@modelcontextprotocol/sdk/client/${path}.js`)[name], "function");',
      ],
      { cwd: stage, encoding: "utf8", env: { ...process.env, NODE_PATH: "" } },
    );
    assert.strictEqual(loaded.status, 0, loaded.stderr || loaded.stdout);
  } finally {
    NodeFS.rmSync(stage, { recursive: true, force: true });
  }
});

it("loads Modal's CBOR codec from an isolated runtime sidecar", () => {
  const selected = selectCliRuntimeExternalDependencies(serverPackageJson.dependencies);
  assert.strictEqual(selected["cbor-x"], "1.6.6");
  const root = NodePath.join(serverRoot, "node_modules/cbor-x");
  const stage = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "paperplane-cbor-sidecar-"));
  try {
    const closure = runtimePackageClosure(root);
    assert.isAtLeast(closure.size, 1);
    for (const [directory, { name }] of closure) {
      NodeFS.cpSync(directory, NodePath.join(stage, "node_modules", name), { recursive: true });
    }
    const loaded = NodeChildProcess.spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        'import { encode, decode } from "cbor-x"; ' +
          'import assert from "node:assert/strict"; ' +
          'const value = { message: "sandbox", values: [1, 2, 3] }; ' +
          "assert.deepEqual(decode(encode(value)), value);",
      ],
      { cwd: stage, encoding: "utf8" },
    );
    assert.strictEqual(loaded.status, 0, loaded.stderr || loaded.stdout);
  } finally {
    NodeFS.rmSync(stage, { recursive: true, force: true });
  }
});

it(
  "bundles the server CLI without inlining Pi or CBOR runtime sources",
  { timeout: 240000 },
  async () => {
    const dist = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "paperplane-cli-pi-bundle-check-"),
    );
    try {
      const packed = NodeChildProcess.spawnSync("vp", ["pack", "--out-dir", dist], {
        cwd: serverRoot,
        encoding: "utf8",
        timeout: 180_000,
      });
      assert.strictEqual(packed.status, 0, packed.stderr || packed.stdout);
      let totalRegions = 0;
      for (const file of NodeFS.readdirSync(dist).filter((name) => name.endsWith(".mjs"))) {
        const result = findInlinedExternalPackages(
          NodeFS.readFileSync(NodePath.join(dist, file), "utf8"),
        );
        totalRegions += result.regionCount;
        assert.deepStrictEqual(result.inlined, [], file);
        for (const name of result.inlinedPackages) {
          assert.notMatch(name, /^(?:cbor-x|cbor-extract|@cbor-extract\/)/, file);
        }
      }
      assert.isAtLeast(totalRegions, 1);
    } finally {
      NodeFS.rmSync(dist, { recursive: true, force: true });
    }
  },
);
