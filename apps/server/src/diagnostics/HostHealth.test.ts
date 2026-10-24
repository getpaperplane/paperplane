import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@getpaperplane/shared/HostProcess";
import * as ByteSize from "effect/ByteSize";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as HostHealth from "./HostHealth.ts";

const GIB = 1024 ** 3;
const now = Date.parse("2026-06-01T12:00:00Z");
const healthy = {
  totalMemoryBytes: 16 * GIB,
  availableMemoryBytes: 8 * GIB,
  swapTotalBytes: 4 * GIB,
  wsl: false,
  userManager: true,
  roveMemory: null,
  hostOomKills: 0,
  stalls: [],
};
const roveMemory = {
  limitBytes: 8 * GIB,
  currentBytes: GIB,
  swapLimitBytes: null,
  swapCurrentBytes: 0,
  oomKills: 4,
};

describe("hostHealthFindings", () => {
  it.each([
    ["wsl_without_systemd", { wsl: true, userManager: false }],
    ["memory_pressure", { availableMemoryBytes: GIB - 1 }],
    ["no_swap", { totalMemoryBytes: 8 * GIB, swapTotalBytes: 0 }],
    ["event_loop_stalls", { stalls: [{ time: now, delayMaxMs: 1000 }] }],
    ["rove_oom_kills", { roveMemory }],
    ["host_oom_kills", { hostOomKills: 4 }],
  ])("reports %s", (id, patch) => {
    const findings = HostHealth.hostHealthFindings(
      { ...healthy, ...patch },
      { now, oomBaseline: 2 },
    );
    expect(findings.map((finding) => finding.id)).toEqual([id]);
    expect(findings[0]?.fix).toBeTruthy();
  });

  it("applies the 24 hour window, excludes future and short stalls, and reports the worst", () => {
    const findings = HostHealth.hostHealthFindings(
      {
        ...healthy,
        stalls: [
          { time: now - 86400000, delayMaxMs: 1000 },
          { time: now, delayMaxMs: 2500 },
          { time: now - 86400001, delayMaxMs: 9000 },
          { time: now + 1, delayMaxMs: 9000 },
          { time: now, delayMaxMs: 999 },
        ],
      },
      { now, oomBaseline: 0 },
    );
    expect(findings[0]?.message).toBe("2 event-loop stalls, worst 2.5 s in the last 24 hours.");
  });

  it("uses cgroup deltas and does not attribute host kills when a slice exists", () => {
    expect(
      HostHealth.hostHealthFindings(
        { ...healthy, roveMemory, hostOomKills: 100 },
        { now, oomBaseline: 4 },
      ),
    ).toEqual([]);
    expect(
      HostHealth.hostHealthFindings({ ...healthy, roveMemory }, { now, oomBaseline: 2 })[0]
        ?.message,
    ).toContain("2 out-of-memory kills under the Paperplane memory ceiling");
    expect(
      HostHealth.hostHealthFindings({ ...healthy, roveMemory }, { now, oomBaseline: 5 }),
    ).toEqual([]);
  });

  it("offers WSL-specific memory and swap fixes, but no swap finding for large hosts", () => {
    const findings = HostHealth.hostHealthFindings(
      {
        ...healthy,
        totalMemoryBytes: 8 * GIB,
        availableMemoryBytes: 0,
        swapTotalBytes: 0,
        wsl: true,
      },
      { now, oomBaseline: 0 },
    );
    expect(findings.map((finding) => finding.fix).join(" ")).toContain("memory=");
    expect(findings.map((finding) => finding.fix).join(" ")).toContain("swap=4GB");
    expect(
      HostHealth.hostHealthFindings({ ...healthy, swapTotalBytes: 0 }, { now, oomBaseline: 0 }),
    ).toEqual([]);
  });
});

const fileInfo = (mtime: number): FileSystem.File.Info => ({
  type: "File",
  mtime: Option.some(DateTime.toDateUtc(DateTime.makeUnsafe(mtime))),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0n,
  ino: Option.none(),
  mode: 0,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: ByteSize.bytes(0),
  blksize: Option.none(),
  blocks: Option.none(),
});

describe("HostHealth service", () => {
  it.effect(
    "reads proc/cgroup/stalls, caches concurrent reads, and reparses stalls only after mtime changes",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const slice = "/sys/fs/cgroup/custom/user@123.service/app.slice/app-rove.slice";
        const files = new Map([
          ["/proc/meminfo", "SwapTotal: 4194304 kB\nSwapFree: 2097152 kB\n"],
          ["/proc/sys/kernel/osrelease", "microsoft-standard-WSL2"],
          ["/proc/self/cgroup", "0::/custom/user@123.service/app.slice/rove.service\n"],
          ["/proc/vmstat", "oom_kill 40\n"],
          [`${slice}/memory.current`, String(GIB + 1)],
          [`${slice}/memory.max`, String(8 * GIB)],
          [`${slice}/memory.swap.max`, "max"],
          [`${slice}/memory.swap.current`, String(GIB)],
          [`${slice}/memory.events`, "oom_kill 2\n"],
        ]);
        let stallReads = 0;
        let mtime = 1;
        let memoryReads = 0;
        const fs = FileSystem.layerNoop({
          exists: (path) => Effect.succeed(files.has(path)),
          readFileString: (path) =>
            Effect.gen(function* () {
              if (path === `${config.logsDir}/event-loop-stalls.ndjson`) {
                stallReads++;
                return `invalid\n${JSON.stringify({ time: DateTime.formatIso(yield* DateTime.now), delayMaxMs: 2300 })}\n`;
              }
              return files.get(path) ?? "";
            }),
          stat: () => Effect.succeed(fileInfo(mtime)),
        });
        const resources = Layer.succeed(
          HostResources.HostResources,
          HostResources.HostResources.of({
            read: Effect.die("unused CPU read"),
            readMemory: Effect.sync(() => {
              memoryReads++;
              return { totalMemoryBytes: 8 * GIB, availableMemoryBytes: 2 * GIB + 1 };
            }),
          }),
        );
        yield* Effect.gen(function* () {
          const health = yield* HostHealth.HostHealth;
          const [first, cached] = yield* Effect.all([health.read, health.read], {
            concurrency: "unbounded",
          });
          expect(first).toEqual(cached);
          expect(memoryReads).toBe(1);
          expect(first.swapTotalBytes).toBe(4 * GIB);
          expect(first.swapFreeBytes).toBe(2 * GIB);
          expect(first.roveMemory).toEqual({
            ...roveMemory,
            currentBytes: GIB + 1,
            swapCurrentBytes: GIB,
            oomKills: 2,
          });
          expect(first.findings.map((finding) => finding.id)).toEqual([
            "wsl_without_systemd",
            "event_loop_stalls",
          ]);
          files.set(`${slice}/memory.events`, "oom_kill 3\n");
          yield* TestClock.adjust("11 seconds");
          const next = yield* health.read;
          expect(next.findings.map((finding) => finding.id)).toContain("rove_oom_kills");
          expect(stallReads).toBe(1);
          mtime++;
          yield* TestClock.adjust("11 seconds");
          yield* health.read;
          expect(stallReads).toBe(2);
          // Subscribing immediately uses the same shared cache rather than reading again.
          yield* Stream.runCollect(health.changes.pipe(Stream.take(1)));
          expect(memoryReads).toBe(3);
        }).pipe(
          Effect.provide(HostHealth.layer.pipe(Layer.provide([fs, resources]))),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.UserId, 123),
          Effect.provideService(HostProcess.Environment, {}),
        );
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "rove-host-health-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect(
    "discovers a nonstandard cgroup created after monitoring starts and preserves small byte counts",
    () =>
      Effect.gen(function* () {
        const files = new Map<string, string>();
        const slice = "/sys/fs/cgroup/later/user@123.service/app.slice/app-rove.slice";
        yield* Effect.gen(function* () {
          const health = yield* HostHealth.HostHealth;
          expect((yield* health.read).roveMemory).toBeNull();
          files.set("/proc/self/cgroup", "0::/later/user@123.service/app.slice/rove.service\n");
          files.set(`${slice}/memory.current`, "1234567");
          files.set(`${slice}/memory.max`, "987654321");
          yield* TestClock.adjust("11 seconds");
          const report = yield* health.read;
          expect(report.roveMemory?.currentBytes).toBe(1234567);
          expect(report.roveMemory?.limitBytes).toBe(987654321);
          expect(report.availableMemoryBytes).toBe(8 * GIB + 1);
        }).pipe(
          Effect.provide(
            HostHealth.layer.pipe(
              Layer.provide([
                FileSystem.layerNoop({
                  exists: (path) => Effect.succeed(files.has(path)),
                  readFileString: (path) => Effect.sync(() => files.get(path) ?? ""),
                }),
                Layer.succeed(
                  HostResources.HostResources,
                  HostResources.HostResources.of({
                    read: Effect.die("unused"),
                    readMemory: Effect.succeed({
                      totalMemoryBytes: 16 * GIB,
                      availableMemoryBytes: 8 * GIB + 1,
                    }),
                  }),
                ),
              ]),
            ),
          ),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.UserId, 123),
          Effect.provideService(HostProcess.Environment, {}),
        );
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "rove-host-health-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("reports memory and event-loop stalls on non-Linux", () =>
    Effect.gen(function* () {
      const health = yield* HostHealth.HostHealth;
      const report = yield* health.read;
      expect(report.swapTotalBytes).toBeNull();
      expect(report.roveMemory).toBeNull();
      expect(report.findings.map((finding) => finding.id)).toEqual([
        "memory_pressure",
        "event_loop_stalls",
      ]);
    }).pipe(
      Effect.provide(
        HostHealth.layer.pipe(
          Layer.provide([
            FileSystem.layerNoop({
              stat: () => Effect.succeed(fileInfo(1)),
              readFileString: (path) =>
                path.endsWith("event-loop-stalls.ndjson")
                  ? DateTime.now.pipe(
                      Effect.map((time) =>
                        JSON.stringify({ time: DateTime.formatIso(time), delayMaxMs: 2300 }),
                      ),
                    )
                  : Effect.die("non-Linux proc read"),
            }),
            Layer.succeed(
              HostResources.HostResources,
              HostResources.HostResources.of({
                read: Effect.die("unused"),
                readMemory: Effect.succeed({ totalMemoryBytes: 8 * GIB, availableMemoryBytes: 0 }),
              }),
            ),
          ]),
        ),
      ),
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "rove-host-health-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
