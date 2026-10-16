#!/usr/bin/env node
// Fresh-state source or bundled server benchmark. Readiness deliberately uses TCP:
// requesting / can wait indefinitely when the source entry has no web assets.
import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    entry: { type: "string", default: "apps/server/src/bin.ts" },
    "idle-seconds": { type: "string", default: "60" },
    "ready-timeout-seconds": { type: "string", default: "60" },
    "cpu-prof": { type: "boolean", default: false },
    "profile-dir": { type: "string" },
  },
});
const runs = Number(values.runs);
const idleSeconds = Number(values["idle-seconds"]);
const readyTimeoutSeconds = Number(values["ready-timeout-seconds"]);
if (
  !Number.isInteger(runs) ||
  runs < 1 ||
  !Number.isFinite(idleSeconds) ||
  idleSeconds < 0 ||
  !Number.isFinite(readyTimeoutSeconds) ||
  readyTimeoutSeconds <= 0
) {
  throw new Error(
    "runs must be a positive integer, idle-seconds nonnegative, and ready timeout positive",
  );
}
const entry = resolve(values.entry);
const profileDir = values["cpu-prof"]
  ? values["profile-dir"]
    ? resolve(values["profile-dir"])
    : await mkdtemp(join(tmpdir(), "rove-boot-profiles-"))
  : undefined;
const baseDir = await mkdtemp(join(tmpdir(), "rove-boot-"));
const exec = promisify(execFile);
let active: ReturnType<typeof spawn> | undefined;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
  active?.kill("SIGTERM");
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

async function freePort() {
  const server = createServer();
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP port allocated");
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
  return address.port;
}

async function connects(port: number) {
  return new Promise<boolean>((accept) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const finish = (ready: boolean) => {
      socket.destroy();
      accept(ready);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(200, () => finish(false));
  });
}

async function sample(pid: number, atSeconds: number) {
  const { stdout } = await exec("ps", ["-p", String(pid), "-o", "rss=,time="]);
  const match = stdout.trim().match(/^(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) throw new Error(`Unexpected ps output: ${stdout}`);
  const [, rss, days, hours, minutes, seconds] = match;
  return {
    atSeconds,
    rssMb: Number(rss) / 1024,
    cpuSeconds:
      Number(days ?? 0) * 86400 +
      Number(hours ?? 0) * 3600 +
      Number(minutes) * 60 +
      Number(seconds),
  };
}

async function run(index: number) {
  if (interrupted) throw new Error("Benchmark interrupted");
  const port = await freePort();
  const home = join(baseDir, String(index));
  const started = performance.now();
  const child = spawn(
    process.execPath,
    [
      ...(profileDir
        ? ["--cpu-prof", `--cpu-prof-dir=${profileDir}`, `--cpu-prof-name=boot-${index}.cpuprofile`]
        : []),
      entry,
      "serve",
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--base-dir",
      home,
      "--no-browser",
    ],
    { env: { ...process.env, ROVE_HOME: home }, stdio: ["ignore", "pipe", "pipe"] },
  );
  active = child;
  let output = "";
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (data: Buffer) => {
      output = (output + data.toString()).slice(-8000);
    });
  }
  const closed = new Promise<void>((accept) => child.once("close", () => accept()));
  try {
    while (!(await connects(port))) {
      if (spawnError) throw spawnError;
      if (interrupted || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Server exited before readiness: ${output}`);
      }
      if (performance.now() - started > readyTimeoutSeconds * 1000) {
        throw new Error(`Server readiness timed out: ${output}`);
      }
      await delay(20);
    }
    const readyMs = performance.now() - started;
    const readyAt = performance.now();
    if (!child.pid) throw new Error("Server has no PID");
    const samples = [await sample(child.pid, 0)];
    const idleTimes = [
      ...new Set([...(idleSeconds >= 10 ? [10] : []), ...(idleSeconds > 0 ? [idleSeconds] : [])]),
    ];
    for (const seconds of idleTimes) {
      await delay(Math.max(0, seconds * 1000 - (performance.now() - readyAt)));
      if (interrupted) throw new Error("Benchmark interrupted");
      samples.push(await sample(child.pid, seconds));
    }
    return { run: index, readyMs, samples };
  } finally {
    // Never enumerate or signal other processes, including providers or dev servers.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        await closed;
      } finally {
        clearTimeout(timeout);
      }
    }
    active = undefined;
    await rm(home, { recursive: true, force: true });
  }
}

function median(numbers: number[]) {
  const sorted = numbers.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

try {
  const results: Awaited<ReturnType<typeof run>>[] = [];
  for (let index = 1; index <= runs; index++) {
    results.push(await run(index));
    console.error(`Finished run ${index}/${runs}`);
  }
  console.log(
    JSON.stringify(
      {
        entry,
        node: process.version,
        runs,
        idleSeconds,
        ...(profileDir ? { profileDir } : {}),
        results,
        median: {
          readyMs: median(results.map((result) => result.readyMs)),
          samples: results[0]!.samples.map((point, index) => ({
            atSeconds: point.atSeconds,
            rssMb: median(results.map((result) => result.samples[index]!.rssMb)),
            cpuSeconds: median(results.map((result) => result.samples[index]!.cpuSeconds)),
          })),
        },
      },
      null,
      2,
    ),
  );
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  await rm(baseDir, { recursive: true, force: true });
}
