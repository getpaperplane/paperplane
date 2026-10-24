// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const benchmark = NodePath.join(import.meta.dirname, "server-boot.ts");

it("measures TCP readiness without HTTP, stops each spawned PID and removes its state", async () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-boot-test-"));
  const entry = NodePath.join(directory, "fake-server.mjs");
  const log = NodePath.join(directory, "children.jsonl");
  NodeFS.writeFileSync(
    entry,
    `import { createServer } from "node:net";
import { appendFileSync, mkdirSync } from "node:fs";
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const home = flag("--base-dir");
if (home !== process.env.PAPERPLANE_HOME || flag("--host") !== "127.0.0.1" || !args.includes("--no-browser")) process.exit(2);
mkdirSync(home, { recursive: true });
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, home }) + "\\n");
// Accept TCP but never answer HTTP: an HTTP-based readiness probe would hang.
createServer((socket) => socket.on("error", () => {})).listen(Number(flag("--port")), "127.0.0.1");
`,
  );
  try {
    const { stdout } = await execFile(process.execPath, [
      benchmark,
      "--entry",
      entry,
      "--runs",
      "3",
      "--idle-seconds",
      "0",
    ]);
    const summary = JSON.parse(stdout);
    expect(summary.results).toHaveLength(3);
    const readyTimes = summary.results
      .map((run: { readyMs: number }) => run.readyMs)
      .sort((a: number, b: number) => a - b);
    expect(summary.median.readyMs).toBe(readyTimes[1]);
    expect(summary.median.samples).toHaveLength(1);
    expect(summary.median.samples[0].rssMb).toBeGreaterThan(0);
    expect(summary.median.samples[0].cpuSeconds).toBeGreaterThanOrEqual(0);
    for (const line of NodeFS.readFileSync(log, "utf8").trim().split("\n")) {
      const { pid, home } = JSON.parse(line);
      expect(NodeFS.existsSync(home)).toBe(false);
      expect(() => process.kill(pid, 0)).toThrow();
    }
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

it("fails promptly when the spawned entry exits before listening", async () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-boot-failure-"));
  const entry = NodePath.join(directory, "failed-server.mjs");
  NodeFS.writeFileSync(entry, 'console.error("boot failed"); process.exit(3);');
  try {
    await expect(
      execFile(process.execPath, [benchmark, "--entry", entry, "--idle-seconds", "0"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Server exited before readiness: boot failed"),
    });
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
