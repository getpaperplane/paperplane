import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Platform, UserId } from "@rove-code/shared/HostProcess";
import { expect, vi } from "vite-plus/test";
import { prepareBudgetedProcess } from "./ProcessBudget.ts";

const { configure, ensureParent } = vi.hoisted(() => ({
  configure: vi.fn(),
  ensureParent: vi.fn(),
}));

vi.mock("../process/agentScope.ts", () => ({ ensureRoveParentSlice: ensureParent }));
vi.mock("../process/systemdSlice.ts", () => ({
  configureSlice: configure,
  withSliceLock: (_directory: string, _unit: string, body: Effect.Effect<unknown>) => body,
}));

it.effect("explicit pools disable swap and cap RAM at the parent; auto pools inherit both", () =>
  Effect.gen(function* () {
    configure.mockImplementation((_unit: string, limits: { max: number }) =>
      Effect.succeed(limits),
    );
    ensureParent.mockImplementation(() =>
      Effect.succeed({ max: 1024 * 1024 ** 2, swapMax: 512 * 1024 ** 2 }),
    );
    for (const [memory, max, swap] of [
      [384, 384 * 1024 ** 2, "0"],
      [2048, 1024 * 1024 ** 2, "0"],
      ["auto", Infinity, "infinity"],
    ] as const) {
      const budget = yield* prepareBudgetedProcess("unused", [], memory);
      expect(configure).toHaveBeenLastCalledWith("app-rove-workloads.slice", { max }, [
        "CPUQuota=",
        `MemorySwapMax=${swap}`,
      ]);
      expect(budget.memoryMiB).toBe(memory === "auto" ? 1024 : Math.min(memory, 1024));
    }
  }).pipe(Effect.provideService(Platform, "linux"), Effect.provideService(UserId, 1000)),
);

it.effect("isolated pools never reconfigure the shared parent ceiling", () =>
  Effect.gen(function* () {
    configure.mockImplementation((_unit: string, limits: { max: number }) =>
      Effect.succeed(limits),
    );
    ensureParent.mockClear();
    const budget = yield* prepareBudgetedProcess("unused", [], 384, "app-rove-test.slice");
    expect(ensureParent).not.toHaveBeenCalled();
    expect(budget.memoryMiB).toBe(384);
  }).pipe(Effect.provideService(Platform, "linux"), Effect.provideService(UserId, 1000)),
);
