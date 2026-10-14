// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  createPotetoProjectProbe,
  potetoProjectCheckId,
  resolvePotetoImage,
  runPotetoCommand,
  validatePotetoProjectSpec,
  type PotetoProjectSpec,
} from "./PotetoProjectRunner.ts";

const spec: PotetoProjectSpec = {
  task: "Return the expected boundary values.",
  editableFiles: ["subject.ts"],
  contextFiles: [],
  check: {
    module: "subject.ts",
    export: "value",
    cases: [
      { args: [0], expected: 1 },
      { args: [1], expected: 2 },
    ],
  },
};
const image = `sha256:${"a".repeat(64)}`;

describe("Poteto project check definition", () => {
  it.each([
    "../subject.ts",
    "/subject.ts",
    "dir/../subject.ts",
    "dir//subject.ts",
    "dir/./subject.ts",
    ".git/config",
    "dir/.GIT/config",
    "subject\t.ts",
    "subject\n.ts",
    "C:\\subject.ts",
    "subject,other.ts",
    "subject\0.ts",
  ])("rejects non-literal or unpatchable path %j", (path) => {
    expect(() =>
      validatePotetoProjectSpec({
        ...spec,
        editableFiles: [path],
        check: { ...spec.check, module: path },
      }),
    ).toThrow("literal repo-relative");
  });

  it("requires a bounded distinct scope, an approved JS/TS export, and lossless JSON cases", () => {
    expect(validatePotetoProjectSpec(spec)).toEqual(spec);
    for (const bad of [
      { ...spec, contextFiles: ["subject.ts"] },
      { ...spec, editableFiles: [] },
      { ...spec, check: { ...spec.check, module: "other.ts" } },
      { ...spec, check: { ...spec.check, cases: [] } },
      { ...spec, check: { ...spec.check, cases: [{ args: [], expected: -0 }] } },
      { ...spec, check: { ...spec.check, cases: [{ args: [NaN], expected: 1 }] } },
      { ...spec, check: { ...spec.check, cases: [{ args: [], expected: "x".repeat(25_000) }] } },
      {
        ...spec,
        editableFiles: ["subject.json"],
        check: { ...spec.check, module: "subject.json" },
      },
    ])
      expect(() => validatePotetoProjectSpec(bad)).toThrow();
  });

  it("binds check identity to the baseline commit, immutable expectations, and pinned runtime image", () => {
    const id = potetoProjectCheckId("a".repeat(40), spec, image);
    expect(potetoProjectCheckId("a".repeat(40), structuredClone(spec), image)).toBe(id);
    expect(potetoProjectCheckId("b".repeat(40), spec, image)).not.toBe(id);
    expect(
      potetoProjectCheckId(
        "a".repeat(40),
        { ...spec, check: { ...spec.check, export: "other" } },
        image,
      ),
    ).not.toBe(id);
    expect(potetoProjectCheckId("a".repeat(40), spec, `sha256:${"b".repeat(64)}`)).not.toBe(id);
  });
});

describe("bounded host command execution", () => {
  it("passes input without a shell and preserves exit status and stderr", async () => {
    const input = "literal $(echo no) ; `echo no`";
    const result = await runPotetoCommand(
      process.execPath,
      [
        "-e",
        'process.stdin.pipe(process.stdout); process.stderr.write("diagnostic"); process.exitCode = 2;',
      ],
      { input },
    );
    expect(result).toMatchObject({ code: 2, stderr: "diagnostic" });
    expect(result.stdout.toString("utf8")).toBe(input);
  });

  it("bounds output, deadlines, and cancellation, rather than treating terminated commands as checks", async () => {
    await expect(
      runPotetoCommand(process.execPath, ["-e", 'process.stdout.write("x".repeat(4096))'], {
        maxOutputBytes: 16,
      }),
    ).rejects.toThrow("output limit");
    await expect(
      runPotetoCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100 }),
    ).rejects.toThrow("deadline");
    await expect(
      runPotetoCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        signal: AbortSignal.timeout(100),
      }),
    ).rejects.toThrow("stopped");
    await expect(runPotetoCommand("poteto-command-does-not-exist", [])).rejects.toThrow();
  });
});

// Opt in after explicitly preparing a local image; ordinary tests never pull or require Docker.
// POTETO_TEST_DOCKER_IMAGE=node:24-alpine vp test run .../PotetoProjectRunner.test.ts
const dockerImage = process.env.POTETO_TEST_DOCKER_IMAGE;
describe.skipIf(!dockerImage)("Poteto export checks in real Docker isolation", () => {
  let imageId: string;
  const directories: string[] = [];
  beforeAll(async () => {
    imageId = await resolvePotetoImage(dockerImage);
  });
  afterEach(() => {
    for (const directory of directories.splice(0))
      NodeFS.rmSync(directory, { recursive: true, force: true });
  });
  const check = async (
    content: string,
    definition = spec,
    signal = new AbortController().signal,
  ) => {
    const directory = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-poteto-runner-test-")),
    );
    directories.push(directory);
    const probe = createPotetoProjectProbe({
      runDirectory: directory,
      commit: "a".repeat(40),
      spec: definition,
      imageId,
    });
    const result = await probe.run([{ path: "subject.ts", content }], signal);
    const checks = NodePath.join(directory, "checks");
    const evidence = JSON.parse(
      NodeFS.readFileSync(
        NodePath.join(checks, NodeFS.readdirSync(checks)[0]!, "evidence.json"),
        "utf8",
      ),
    );
    return { result, evidence };
  };

  it("compares real outputs on the host and retains the exact failure and passing rows", async () => {
    const failed = await check("export const value = (n: number) => n;");
    expect(failed.result.outcome).toBe("fail");
    expect(failed.evidence.rows).toEqual([
      { args: [0], expected: 1, actual: 0 },
      { args: [1], expected: 2, actual: 1 },
    ]);
    const passed = await check("export const value = (n: number) => n + 1;");
    expect(passed.result.outcome).toBe("pass");
    expect(passed.evidence).toMatchObject({
      outcome: "pass",
      checkId: potetoProjectCheckId("a".repeat(40), spec, imageId),
    });
  });

  it("runs real subject checks through a symlinked run directory without mounting host siblings", async () => {
    // Keep the unresolved alias: the helper above canonicalizes it and would hide the
    // Docker Desktop regression where /tmp is not the VM-shared /private/tmp path.
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-poteto-alias-test-"));
    directories.push(directory);
    const target = NodePath.join(NodeFS.realpathSync(directory), "run");
    NodeFS.mkdirSync(target);
    NodeFS.writeFileSync(NodePath.join(target, "host-only.txt"), "not a candidate file");
    const alias = NodePath.join(directory, "run-alias");
    NodeFS.symlinkSync(target, alias, "junction");
    expect(alias).not.toBe(NodeFS.realpathSync(alias));
    const definition: PotetoProjectSpec = {
      ...spec,
      check: {
        ...spec.check,
        cases: [
          {
            args: [1],
            expected: {
              value: 2,
              workspace: ["subject.ts"],
              harness: ["subject.mjs"],
              hostFile: false,
            },
          },
        ],
      },
    };
    const probe = createPotetoProjectProbe({
      runDirectory: alias,
      commit: "a".repeat(40),
      spec: definition,
      imageId,
    });
    const result = await probe.run(
      [
        {
          path: "subject.ts",
          content: `import fs from 'node:fs';
export const value = (n: number) => ({
  value: n + 1,
  workspace: fs.readdirSync('/workspace'),
  harness: fs.readdirSync('/harness'),
  hostFile: fs.existsSync('/workspace/host-only.txt'),
});`,
        },
      ],
      new AbortController().signal,
    );
    expect(result.outcome, result.output).toBe("pass");
  });

  it("provides read-only scoped files, a non-root process, no network, and no host metadata or credentials", async () => {
    const content = `import fs from 'node:fs';
import os from 'node:os';
export function value() {
  const writable = (path) => { try { fs.writeFileSync(path, 'test'); return true; } catch { return false; } };
  return {
    uid: process.getuid(), home: process.env.HOME,
    files: fs.readdirSync('/workspace'), interfaces: Object.keys(os.networkInterfaces()),
    workspaceWritable: writable('/workspace/other'), rootWritable: writable('/etc/other'), tmpWritable: writable('/tmp/other'),
    git: fs.existsSync('/workspace/.git'), socket: fs.existsSync('/var/run/docker.sock'), rove: fs.existsSync('/root/.rove-code'),
    cases: process.argv.join(' ').includes('expected'),
  };
}`;
    const { result } = await check(content, {
      ...spec,
      check: {
        ...spec.check,
        cases: [
          {
            args: [],
            expected: {
              uid: 65534,
              home: "/tmp",
              files: ["subject.ts"],
              interfaces: ["lo"],
              workspaceWritable: false,
              rootWritable: false,
              tmpWritable: true,
              git: false,
              socket: false,
              rove: false,
              cases: false,
            },
          },
        ],
      },
    });
    expect(result.outcome, result.output).toBe("pass");
  });

  it.each([
    "export const value = () => { throw new Error('broken'); };",
    "import './missing.ts'; export const value = () => 1;",
    "export const value = () => { console.log('not a protocol result'); return 1; };",
    "export const value = () => NaN;",
    "export const value = () => ({ invalid: undefined });",
    "export const value = () => -0;",
  ])(
    "treats crashes, malformed output, and lossy JSON values as inconclusive (%s)",
    async (content) => {
      const { result, evidence } = await check(content, {
        ...spec,
        check: { ...spec.check, cases: [{ args: [], expected: null }] },
      });
      expect(result.outcome).toBe("inconclusive");
      expect(evidence.outcome).toBe("inconclusive");
    },
  );

  it("removes its owned container on operator cancellation instead of returning evidence", async () => {
    const before = await runPotetoCommand("docker", [
      "ps",
      "--all",
      "--filter",
      "name=rove-poteto-check-",
      "--format",
      "{{.Names}}",
    ]);
    await expect(
      check("export const value = () => { while (true) {} };", spec, AbortSignal.timeout(200)),
    ).rejects.toThrow();
    const after = await runPotetoCommand("docker", [
      "ps",
      "--all",
      "--filter",
      "name=rove-poteto-check-",
      "--format",
      "{{.Names}}",
    ]);
    expect(after.stdout.toString("utf8")).toBe(before.stdout.toString("utf8"));
  });

  it("terminates an infinite export and removes its owned container", async () => {
    const running = await runPotetoCommand("docker", [
      "ps",
      "--all",
      "--filter",
      "name=rove-poteto-check-",
      "--format",
      "{{.Names}}",
    ]);
    const { result } = await check("export const value = () => { while (true) {} };");
    expect(result).toMatchObject({
      outcome: "inconclusive",
      output: expect.stringContaining("deadline"),
    });
    const after = await runPotetoCommand("docker", [
      "ps",
      "--all",
      "--filter",
      "name=rove-poteto-check-",
      "--format",
      "{{.Names}}",
    ]);
    expect(after.stdout.toString("utf8")).toBe(running.stdout.toString("utf8"));
  }, 30_000);
});
