// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Standalone prototype host.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { PotetoProjectSpec } from "@rove-code/contracts";
import * as Schema from "effect/Schema";
import type { PotetoFiles, PotetoProbe } from "./PotetoMode.ts";

export { PotetoProjectSpec } from "@rove-code/contracts";
const decodeSpec = Schema.decodeUnknownSync(PotetoProjectSpec);
export const decodePotetoProjectSpecJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(PotetoProjectSpec),
);

/** Scopes are literal repo-relative files, never globs, directories, symlinks, or .git paths. */
export function validatePotetoProjectSpec(input: unknown): PotetoProjectSpec {
  const spec = decodeSpec(input);
  const paths = [...spec.editableFiles, ...spec.contextFiles];
  for (const path of [...paths, spec.check.module]) {
    if (
      !path ||
      NodePath.posix.isAbsolute(path) ||
      /[\\\0\t\r\n:,]/.test(path) ||
      path
        .split("/")
        .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
    )
      throw new Error(`Not a literal repo-relative file: ${path}`);
  }
  if (new Set(paths).size !== paths.length || paths.length > 16)
    throw new Error("Scope must contain 1-16 distinct files.");
  if (!paths.includes(spec.check.module))
    throw new Error("Check module must be in the approved snapshot.");
  if (!/\.(?:[cm]?js|[cm]?ts)$/.test(spec.check.module))
    throw new Error("Pilot checks support dependency-free JS/TS exports only.");
  if (!NodeUtil.isDeepStrictEqual(spec.check.cases, JSON.parse(JSON.stringify(spec.check.cases))))
    throw new Error("Check cases must round-trip losslessly through JSON.");
  if (JSON.stringify(spec).length > 24_000)
    throw new Error("Check specification exceeds the pilot budget.");
  return spec;
}

/** Commands never use a shell. Limits cover control commands as well as candidate execution. */
export async function runPotetoCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxOutputBytes?: number;
  } = {},
) {
  options.signal?.throwIfAborted();
  const limit = options.maxOutputBytes ?? 65_536;
  return new Promise<{ code: number | null; stdout: Buffer; stderr: string }>((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => stop(new Error("Pilot command deadline exceeded.")),
      options.timeoutMs ?? 30_000,
    );
    const abort = () => stop(new Error("Pilot check stopped."));
    options.signal?.addEventListener("abort", abort, { once: true });
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) stop(new Error("Pilot command output limit exceeded."));
      else target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.stdin.on("error", () => {});
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else
        resolve({
          code,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    });
    child.stdin.end(options.input);
    if (options.signal?.aborted) abort();
  });
}

// No expected outputs or pass/fail authority enter the candidate process.
// The host compares the returned JSON values, not a candidate-authored test verdict.
export const POTETO_SUBJECT_PROGRAM = `import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
const input = JSON.parse(fs.readFileSync(0, "utf8"));
try {
  const module = await import(pathToFileURL("/workspace/" + input.module).href);
  const fn = module[input.export];
  if (typeof fn !== "function") throw new Error("Requested export is not a function");
  const results = [];
  for (const args of input.args) {
    const value = await fn(...args);
    const encoded = JSON.stringify(value);
    if (encoded === undefined || !isDeepStrictEqual(value, JSON.parse(encoded))) throw new Error("Export returned a non-JSON or lossy value");
    results.push(JSON.parse(encoded));
  }
  process.stdout.write(JSON.stringify({ results }));
} catch (error) {
  process.stderr.write(String(error));
  process.exitCode = 2;
}
`;
const decodeReturnedValues = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ results: Schema.Array(Schema.Json) })),
);
const decodeImageId = Schema.decodeUnknownSync(
  Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
);
export const DEFAULT_POTETO_IMAGE = "node:24-alpine";

export async function resolvePotetoImage(image = DEFAULT_POTETO_IMAGE) {
  const result = await runPotetoCommand("docker", [
    "image",
    "inspect",
    image,
    "--format",
    "{{.Id}}",
  ]);
  if (result.code !== 0)
    throw new Error(
      `Docker image is unavailable. Prepare it explicitly with: docker pull ${image}\n${result.stderr.slice(0, 1000)}`,
    );
  return decodeImageId(result.stdout.toString("utf8").trim());
}
export function potetoProjectCheckId(commit: string, spec: PotetoProjectSpec, imageId: string) {
  return `node-export-v1/${NodeCrypto.createHash("sha256")
    .update(JSON.stringify({ commit, spec, imageId, program: POTETO_SUBJECT_PROGRAM }))
    .digest("hex")}`;
}

/** Only the scoped candidate and this immutable protocol helper are mounted.
 * No Git metadata, Rove state, credentials, Docker socket, or host dependencies.
 * Containers are named by the run before creation, so cleanup targets only our own resources.
 */
export function createPotetoProjectProbe(options: {
  runDirectory: string;
  commit: string;
  spec: PotetoProjectSpec;
  imageId: string;
}): PotetoProbe {
  const spec = validatePotetoProjectSpec(options.spec);
  const imageId = decodeImageId(options.imageId);
  const probesPath = NodePath.join(options.runDirectory, "checks");
  NodeFS.mkdirSync(probesPath, { recursive: true });
  // Desktop Docker VMs share canonical host paths, not aliases such as macOS /tmp.
  const probes = NodeFS.realpathSync(probesPath);
  return {
    id: potetoProjectCheckId(options.commit, spec, imageId),
    run: async (files: PotetoFiles, signal) => {
      signal.throwIfAborted();
      const directory = NodeFS.mkdtempSync(NodePath.join(probes, "check-"));
      const workspace = NodePath.join(directory, "candidate");
      const harness = NodePath.join(directory, "harness");
      NodeFS.mkdirSync(workspace, { mode: 0o755 });
      NodeFS.mkdirSync(harness, { mode: 0o755 });
      for (const file of files) {
        if (![...spec.editableFiles, ...spec.contextFiles].includes(file.path))
          throw new Error("Probe received an out-of-scope file.");
        const target = NodePath.join(workspace, file.path);
        NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true, mode: 0o755 });
        NodeFS.writeFileSync(target, file.content, { mode: 0o644 });
      }
      NodeFS.writeFileSync(NodePath.join(harness, "subject.mjs"), POTETO_SUBJECT_PROGRAM, {
        mode: 0o644,
      });
      const name = `rove-poteto-check-${NodeCrypto.randomUUID()}`;
      let result: Awaited<ReturnType<typeof runPotetoCommand>> | undefined;
      try {
        // Never pull during a run. The image ID is pinned in the check identity.
        const created = await runPotetoCommand("docker", [
          "create",
          "--name",
          name,
          "--pull=never",
          "--network=none",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--user=65534:65534",
          "--memory=256m",
          "--cpus=1",
          "--pids-limit=32",
          "--interactive",
          "--mount",
          `type=bind,source=${workspace},target=/workspace,readonly`,
          "--mount",
          `type=bind,source=${harness},target=/harness,readonly`,
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,size=16m,mode=1777",
          "--env",
          "HOME=/tmp",
          "--env",
          "TMPDIR=/tmp",
          "--workdir=/workspace",
          imageId,
          "node",
          "--max-old-space-size=128",
          "--disable-proto=throw",
          "/harness/subject.mjs",
        ]);
        if (created.code !== 0)
          throw new Error(`Container creation failed: ${created.stderr.slice(0, 1000)}`);
        signal.throwIfAborted();
        result = await runPotetoCommand("docker", ["start", "--attach", "--interactive", name], {
          input: JSON.stringify({
            module: spec.check.module,
            export: spec.check.export,
            args: spec.check.cases.map((test) => test.args),
          }),
          signal,
          timeoutMs: 15_000,
        });
        if (result.code !== 0)
          throw new Error(
            `Export could not execute (exit ${result.code}): ${result.stderr.slice(0, 2000)}`,
          );
        const actual = decodeReturnedValues(result.stdout.toString("utf8"));
        if (actual.results.length !== spec.check.cases.length)
          throw new Error("Export returned the wrong result count.");
        const rows = spec.check.cases.map((test, index) => ({
          args: test.args,
          expected: test.expected,
          actual: actual.results[index],
        }));
        const passed = rows.every((row) => NodeUtil.isDeepStrictEqual(row.actual, row.expected));
        const output = rows
          .map(
            (row, index) =>
              `${index + 1}. args=${JSON.stringify(row.args)} actual=${JSON.stringify(row.actual)} expected=${JSON.stringify(row.expected)}`,
          )
          .join("\n");
        NodeFS.writeFileSync(
          NodePath.join(directory, "evidence.json"),
          JSON.stringify(
            {
              checkId: potetoProjectCheckId(options.commit, spec, imageId),
              outcome: passed ? "pass" : "fail",
              rows,
              stderr: result.stderr,
            },
            null,
            2,
          ),
        );
        return { outcome: passed ? "pass" : "fail", output: output.slice(0, 4000) };
      } catch (error) {
        signal.throwIfAborted();
        const output = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
        NodeFS.writeFileSync(
          NodePath.join(directory, "evidence.json"),
          JSON.stringify({ outcome: "inconclusive", output }, null, 2),
        );
        return { outcome: "inconclusive", output };
      } finally {
        const removed = await runPotetoCommand("docker", ["rm", "--force", name]);
        if (removed.code !== 0 && !removed.stderr.includes("No such container")) {
          // A cleanup failure must block acceptance, even if the export returned passing values.
          // eslint-disable-next-line no-unsafe-finally
          throw new Error(
            `Could not remove owned pilot container ${name}: ${removed.stderr.slice(0, 1000)}`,
          );
        }
      }
    },
  };
}
