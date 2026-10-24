import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Stream from "effect/Stream";
import type { HostHealthReport } from "@getpaperplane/contracts";
import * as HostHealth from "../diagnostics/HostHealth.ts";
import * as Layer from "effect/Layer";

import * as BootService from "../cloud/bootService.ts";
import { runDoctor } from "./doctor.ts";
import { DatabaseMaintenance, DatabaseMissingError } from "../persistence/DatabaseMaintenance.ts";

const hostReport: HostHealthReport = {
  sampledAt: 0,
  totalMemoryBytes: 8 * 1024 ** 3,
  availableMemoryBytes: 512 * 1024 ** 2,
  swapTotalBytes: 4 * 1024 ** 3,
  swapFreeBytes: 3 * 1024 ** 3,
  memoryPressure: true,
  roveMemory: {
    currentBytes: 2 * 1024 ** 3,
    limitBytes: 6 * 1024 ** 3,
    swapCurrentBytes: 0,
    swapLimitBytes: null,
    oomKills: 2,
  },
  findings: [
    {
      id: "memory_pressure",
      severity: "warning",
      message: "Low memory.",
      fix: "Run fewer agents.",
    },
  ],
};
const layerHealth = Layer.succeed(HostHealth.HostHealth, {
  read: Effect.succeed(hostReport),
  changes: Stream.empty,
});

it.effect("--fix reclaims space with the service paused, and --dry-run changes nothing", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const doctor = (dryRun: boolean) =>
      runDoctor("/test/statev2.sqlite", { fix: true, dryRun, interactive: false }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            layerHealth,
            Layer.mock(BootService.BootService)({
              withStopped: (operation) =>
                Effect.sync(() => calls.push("pause")).pipe(
                  Effect.andThen(operation),
                  Effect.ensuring(Effect.sync(() => calls.push("resume"))),
                ),
            }),
            Layer.succeed(DatabaseMaintenance, {
              compactOnStartup: () => Effect.void,
              // An unconverted database: reclaiming space is recommended.
              inspect: () =>
                Effect.succeed({
                  databaseBytes: 2000,
                  reclaimableBytes: 1000,
                  incrementalVacuumEnabled: false,
                }),
              compact: () =>
                Effect.sync(() => {
                  calls.push("compact");
                  return {
                    beforeBytes: 2000,
                    afterBytes: 1000,
                    deletedEventCount: 1,
                    deletedReceiptCount: 0,
                  };
                }),
            }),
          ),
        ),
      );
    yield* doctor(true);
    assert.deepEqual(calls, []);
    yield* doctor(false);
    assert.deepEqual(calls, ["pause", "compact", "resume"]);
  }),
);

it.effect("prints host advice before a database failure without attempting repairs", () =>
  Effect.gen(function* () {
    const lines: string[] = [];
    const result = yield* runDoctor("/missing.sqlite", { fix: true, dryRun: false }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerHealth,
          NodeServices.layer,
          Layer.mock(BootService.BootService)({}),
          Layer.mock(DatabaseMaintenance)({
            inspect: () => Effect.fail(new DatabaseMissingError({ path: "/missing.sqlite" })),
          }),
        ),
      ),
      Effect.provideService(Console.Console, {
        ...globalThis.console,
        log: (...args: ReadonlyArray<unknown>) => {
          lines.push(args.join(" "));
        },
      }),
      Effect.flip,
    );
    assert.equal(result._tag, "DatabaseMissingError");
    assert.deepEqual(lines, [
      "Host:\n  Memory: 512.0 MiB available / 8.00 GiB total",
      "  Swap: 3.00 GiB free / 4.00 GiB total",
      "  Paperplane ceiling: 2.00 GiB current / 6.00 GiB",
      "  [warning] Low memory.",
      "    Fix: Run fewer agents.",
    ]);
  }),
);

it.effect("does not swallow a host-health interrupt or continue to database inspection", () =>
  Effect.gen(function* () {
    const result = yield* runDoctor("/test.sqlite", { fix: false, dryRun: false }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(HostHealth.HostHealth, { read: Effect.interrupt, changes: Stream.empty }),
          Layer.mock(BootService.BootService)({}),
          Layer.mock(DatabaseMaintenance)({ inspect: () => Effect.die("must not inspect") }),
        ),
      ),
      Effect.exit,
    );
    assert.isTrue(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause));
  }),
);

for (const ceiling of ["unlimited", "no systemd", "121 KiB current"] as const) {
  it.effect(`reports ${ceiling} without treating host advice as a repair`, () =>
    Effect.gen(function* () {
      const lines: string[] = [];
      yield* runDoctor("/test.sqlite", { fix: true, dryRun: true }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(HostHealth.HostHealth, {
              read: Effect.succeed({
                ...hostReport,
                swapTotalBytes: null,
                swapFreeBytes: null,
                roveMemory:
                  ceiling === "no systemd"
                    ? null
                    : ceiling === "unlimited"
                      ? { ...hostReport.roveMemory!, limitBytes: null }
                      : { ...hostReport.roveMemory!, currentBytes: 123456 },
              }),
              changes: Stream.empty,
            }),
            Layer.mock(BootService.BootService)({}),
            Layer.mock(DatabaseMaintenance)({
              inspect: () =>
                Effect.sync(() => {
                  lines.push("database inspected");
                  return { databaseBytes: 0, reclaimableBytes: 0, incrementalVacuumEnabled: true };
                }),
            }),
          ),
        ),
        Effect.provideService(Console.Console, {
          ...globalThis.console,
          log: (...args: ReadonlyArray<unknown>) => {
            lines.push(args.join(" "));
          },
        }),
      );
      assert.isTrue(lines[0]!.startsWith("Host:"));
      assert.include(lines[2]!, ceiling);
      assert.include(lines, "  Swap: unavailable");
      assert.isAbove(lines.indexOf("database inspected"), 2);
    }),
  );
}
