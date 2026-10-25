// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone report over a built web bundle.
/**
 * Startup bundle report for apps/web.
 *
 * Walks the static import graph of a `vp build` output (via `.vite/manifest.json`)
 * from index.html's entry, and separately from the chat/thread route chunks, and
 * prints JSON: raw + gzip bytes, file count, files under 2 KB, the largest chunks,
 * and which forbidden-in-startup modules each graph pulls in (read from the
 * chunk sourcemaps when present, chunk names otherwise).
 *
 *   node scripts/perf/web-bundle.ts                 # read apps/web/dist
 *   node scripts/perf/web-bundle.ts --build         # run `vp build` first
 *   node scripts/perf/web-bundle.ts --max-startup-raw 2500000 --forbid-startup
 *
 * Budget flags exit 1 when exceeded, so the script can gate CI later.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeZlib from "node:zlib";

const { join, resolve } = NodePath;

interface ManifestChunk {
  readonly file: string;
  readonly src?: string;
  readonly name?: string;
  readonly isEntry?: boolean;
  readonly isDynamicEntry?: boolean;
  readonly imports?: ReadonlyArray<string>;
  readonly dynamicImports?: ReadonlyArray<string>;
  readonly css?: ReadonlyArray<string>;
}

type Manifest = Record<string, ManifestChunk>;

const repoRoot = resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const webRoot = join(repoRoot, "apps/web");

const SMALL_FILE_BYTES = 2 * 1024;

// index.html loads src/bootstrap.ts, which unconditionally `import()`s main.
const STARTUP_DYNAMIC_ROOTS = ["src/main.tsx"];

// Chunks that make up the chat route once the router resolves a thread URL.
const CHAT_ROUTE_SOURCES = [
  /src\/routes\/_chat\.tsx/,
  /src\/routes\/_chat\.\$environmentId\.\$threadId\.tsx/,
];

// Modules that should never be in the startup graph. `pattern` matches sourcemap
// `sources` (module paths) and, as a fallback, chunk file names. `chunkKey`
// matches manifest keys, which tell split route components (`?tsr-split`) apart
// from the route definitions that the router keeps in main.
const FORBIDDEN: ReadonlyArray<{
  readonly id: string;
  readonly pattern: RegExp;
  readonly chunkKey?: RegExp;
}> = [
  { id: "shiki", pattern: /shared_highlighter|[/@]shikijs?\/|\/shiki\// },
  { id: "pierre-diffs-renderers", pattern: /@pierre\/diffs\/dist\/(react|components|renderers)\// },
  { id: "clerk", pattern: /@clerk\// },
  { id: "lucide-dynamic", pattern: /lucide-react\/dist\/esm\/(dynamic|dynamicIconImports)/ },
  { id: "terminal", pattern: /@xterm\/|ghostty|ThreadTerminalDrawer/ },
  {
    id: "settings-pages",
    pattern: /src\/components\/settings\/[^/]+Settings[^/]*\.tsx/,
    chunkKey: /src\/routes\/settings[^?]*\?tsr-split/,
  },
];

type Section = "startup" | "chatRoute" | "coldThread";
type Metric = "rawBytes" | "gzipBytes" | "files" | "smallFiles";

const BUDGET_FLAGS: ReadonlyArray<{
  readonly flag: string;
  readonly section: Section;
  readonly metric: Metric;
}> = [
  { flag: "--max-startup-raw", section: "startup", metric: "rawBytes" },
  { flag: "--max-startup-gzip", section: "startup", metric: "gzipBytes" },
  { flag: "--max-startup-files", section: "startup", metric: "files" },
  { flag: "--max-startup-small-files", section: "startup", metric: "smallFiles" },
  { flag: "--max-chat-raw", section: "chatRoute", metric: "rawBytes" },
  { flag: "--max-chat-gzip", section: "chatRoute", metric: "gzipBytes" },
  { flag: "--max-chat-files", section: "chatRoute", metric: "files" },
  { flag: "--max-cold-thread-raw", section: "coldThread", metric: "rawBytes" },
  { flag: "--max-cold-thread-gzip", section: "coldThread", metric: "gzipBytes" },
  { flag: "--max-cold-thread-files", section: "coldThread", metric: "files" },
  { flag: "--max-cold-thread-small-files", section: "coldThread", metric: "smallFiles" },
];

interface Budget {
  readonly flag: string;
  readonly section: Section;
  readonly metric: Metric;
  readonly max: number;
}

interface Options {
  readonly dist: string;
  readonly build: boolean;
  readonly budgets: ReadonlyArray<Budget>;
  readonly forbidStartup: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): Options {
  let dist = join(webRoot, "dist");
  let build = false;
  let forbidStartup = false;
  const budgets: Budget[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--build") build = true;
    else if (arg === "--forbid-startup") forbidStartup = true;
    else if (arg === "--dist") dist = resolve(argv[++i] ?? "");
    else if (BUDGET_FLAGS.some((budget) => budget.flag === arg)) {
      const max = Number(argv[++i]);
      if (!Number.isFinite(max)) throw new Error(`${arg} needs a number`);
      budgets.push({ ...BUDGET_FLAGS.find((budget) => budget.flag === arg)!, max });
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: node scripts/perf/web-bundle.ts [--build] [--dist <dir>] [--forbid-startup] ${BUDGET_FLAGS.map(
          ({ flag }) => `[${flag} <n>]`,
        ).join(" ")}`,
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { dist, build, budgets, forbidStartup };
}

function staticClosure(manifest: Manifest, roots: ReadonlyArray<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const key = stack.pop()!;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const next of manifest[key]?.imports ?? []) stack.push(next);
  }
  return seen;
}

interface FileStats {
  readonly file: string;
  readonly raw: number;
  readonly gzip: number;
  readonly modules: ReadonlyArray<string>;
}

function makeStatsReader(dist: string) {
  const cache = new Map<string, FileStats>();
  return (file: string): FileStats => {
    const cached = cache.get(file);
    if (cached) return cached;
    const bytes = NodeFS.readFileSync(join(dist, file));
    const mapPath = join(dist, `${file}.map`);
    let modules: string[] = [];
    if (NodeFS.existsSync(mapPath)) {
      const sources: unknown = JSON.parse(NodeFS.readFileSync(mapPath, "utf8"))?.sources;
      if (Array.isArray(sources)) modules = sources.filter((source) => typeof source === "string");
    }
    const gzip = NodeZlib.gzipSync(bytes, { level: 9 }).length;
    const stats = { file, raw: bytes.length, gzip, modules };
    cache.set(file, stats);
    return stats;
  };
}

function summarize(
  manifest: Manifest,
  keySet: Iterable<string>,
  read: (file: string) => FileStats,
) {
  const keys = [...keySet];
  const files = [
    ...new Set(keys.map((key) => manifest[key]?.file).filter((f) => f?.endsWith(".js"))),
  ]
    .map((file) => read(file!))
    .sort((a, b) => b.raw - a.raw);
  const flags: Record<string, string[]> = {};
  for (const { id, pattern, chunkKey } of FORBIDDEN) {
    const hits = new Set(
      files
        .filter(
          (stats) =>
            pattern.test(stats.file) || stats.modules.some((module) => pattern.test(module)),
        )
        .map((stats) => stats.file),
    );
    if (chunkKey) {
      for (const key of keys) if (chunkKey.test(key)) hits.add(manifest[key]!.file);
    }
    if (hits.size > 0) flags[id] = [...hits];
  }
  return {
    rawBytes: files.reduce((sum, stats) => sum + stats.raw, 0),
    gzipBytes: files.reduce((sum, stats) => sum + stats.gzip, 0),
    files: files.length,
    smallFiles: files.filter((stats) => stats.raw < SMALL_FILE_BYTES).length,
    top: files.slice(0, 15).map(({ file, raw, gzip }) => ({ file, raw, gzip })),
    forbidden: flags,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.build) {
    NodeChildProcess.execFileSync("vp", ["build"], {
      cwd: webRoot,
      // Build logs go to stderr so stdout stays parseable JSON.
      stdio: ["ignore", process.stderr, "inherit"],
      env: {
        ...process.env,
        PAPERPLANE_WEB_SOURCEMAP: process.env.PAPERPLANE_WEB_SOURCEMAP ?? "hidden",
      },
    });
  }
  const manifestPath = join(options.dist, ".vite/manifest.json");
  if (!NodeFS.existsSync(manifestPath)) {
    throw new Error(`No manifest at ${manifestPath}; run with --build or build apps/web first.`);
  }
  // SAFETY: Vite writes this file in the documented ManifestChunk shape.
  const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as Manifest;
  const read = makeStatsReader(options.dist);

  const entryKey = Object.keys(manifest).find(
    (key) => manifest[key]!.isEntry && key.endsWith("index.html"),
  );
  if (!entryKey) throw new Error("index.html entry not found in manifest");
  const chatKeys = Object.keys(manifest).filter((key) =>
    CHAT_ROUTE_SOURCES.some((pattern) => pattern.test(key)),
  );

  const startupKeys = staticClosure(manifest, [
    entryKey,
    ...STARTUP_DYNAMIC_ROOTS.filter((key) => key in manifest),
  ]);
  const chatClosure = staticClosure(manifest, chatKeys);
  const chatOnlyKeys = [...chatClosure].filter((key) => !startupKeys.has(key));
  const startup = summarize(manifest, startupKeys, read);
  const chatRoute = summarize(manifest, chatOnlyKeys, read);
  const coldThread = summarize(manifest, new Set([...startupKeys, ...chatClosure]), read);
  const allJs = summarize(
    manifest,
    Object.keys(manifest).filter((key) => manifest[key]!.file.endsWith(".js")),
    read,
  );

  const report = {
    dist: options.dist,
    chatRouteChunks: chatKeys,
    startup,
    chatRoute,
    coldThread: { ...coldThread, top: undefined },
    allChunks: { rawBytes: allJs.rawBytes, files: allJs.files, smallFiles: allJs.smallFiles },
  };
  console.log(JSON.stringify(report, null, 2));

  const failures: string[] = [];
  const sections = { startup, chatRoute, coldThread };
  for (const { flag, section, metric, max } of options.budgets) {
    const actual = sections[section][metric];
    if (actual > max) failures.push(`${flag}: ${section}.${metric} = ${actual} > ${max}`);
  }
  if (options.forbidStartup) {
    for (const id of Object.keys(startup.forbidden)) failures.push(`startup includes ${id}`);
  }
  if (failures.length > 0) {
    console.error(`Bundle budget exceeded:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
}

main();
