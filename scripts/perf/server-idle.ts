#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off - Standalone benchmark that samples its own server process.
// Run from the repository root: node scripts/perf/server-idle.ts --seconds 120
// Uses a new empty home, TCP readiness (HTTP readiness can hang), and only its own child PID.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const secondsIndex = process.argv.indexOf("--seconds");
const seconds = secondsIndex < 0 ? 120 : Number(process.argv[secondsIndex + 1]);
if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--seconds must be positive");
const reservation = createServer();
await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const address = reservation.address();
if (address === null || typeof address === "string") throw new Error("No TCP port");
const port = address.port;
await new Promise<void>((resolve) => reservation.close(() => resolve()));
const home = mkdtempSync(join(tmpdir(), "rove-idle-"));
const child = spawn(
  process.execPath,
  [
    "apps/server/src/bin.ts",
    "serve",
    "--port",
    String(port),
    "--host",
    "127.0.0.1",
    "--base-dir",
    home,
    "--no-browser",
  ],
  {
    env: { ...process.env, ROVE_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let log = "";
child.stdout.on("data", (data: Buffer) => {
  log = (log + data.toString()).slice(-12000);
});
child.stderr.on("data", (data: Buffer) => {
  log = (log + data.toString()).slice(-12000);
});
const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
function counters() {
  if (child.exitCode !== null || child.signalCode !== null)
    throw new Error(`Server exited during measurement:\n${log}`);
  const time = execFileSync("ps", ["-p", String(child.pid), "-o", "time="], {
    encoding: "utf8",
  }).trim();
  const parts = time.split(":").map(Number);
  const cpuSeconds = parts.reduce((total, part) => total * 60 + part, 0);
  let contextSwitches: number | null = null;
  if (process.platform === "linux") {
    const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
    contextSwitches = [...status.matchAll(/(?:non)?voluntary_ctxt_switches:\s+(\d+)/g)].reduce(
      (sum, match) => sum + Number(match[1]),
      0,
    );
  }
  // macOS ps exposes CPU time, but not cumulative context-switch counters.
  return { cpuSeconds, contextSwitches };
}
try {
  const deadline = Date.now() + 120000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Server exited before readiness:\n${log}`);
    const ready = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ready) break;
    if (Date.now() > deadline) throw new Error(`TCP readiness timed out:\n${log}`);
    await delay(100);
  }
  await delay(10000); // Exclude boot/recovery from the measured idle window.
  const before = counters();
  await delay(seconds * 1000);
  const after = counters();
  console.log(
    JSON.stringify(
      {
        seconds,
        cpuSeconds: after.cpuSeconds - before.cpuSeconds,
        contextSwitches:
          before.contextSwitches === null || after.contextSwitches === null
            ? null
            : after.contextSwitches - before.contextSwitches,
        fixture: "empty isolated home, no clients",
        platform: process.platform,
      },
      null,
      2,
    ),
  );
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([exited, delay(10000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }
  rmSync(home, { recursive: true, force: true });
}
