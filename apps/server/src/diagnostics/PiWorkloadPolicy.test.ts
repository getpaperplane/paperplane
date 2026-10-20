import { describe, expect, it, vi } from "vite-plus/test";

const control = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
vi.mock("./ProcessBudget.ts", async (original) => ({
  ...(await original<typeof import("./ProcessBudget.ts")>()),
  executeProcessControl: control,
}));
import { resolvePiWorkloadMemory } from "./PiWorkloadPolicy.ts";

const gib = 1024 ** 3;
describe("Pi workload policy", () => {
  it("leaves larger, unsupported, too-small and explicitly disabled hosts alone", async () => {
    control.mockReset();
    expect(await resolvePiWorkloadMemory("auto", "auto", {}, "linux", 16 * gib)).toBeUndefined();
    expect(
      await resolvePiWorkloadMemory("auto", "auto", {}, "linux", 512 * 1024 ** 2),
    ).toBeUndefined();
    expect(await resolvePiWorkloadMemory("auto", "auto", {}, "darwin", 4 * gib)).toBeUndefined();
    expect(await resolvePiWorkloadMemory("off", "auto", {}, "linux", 4 * gib)).toBeUndefined();
    expect(control).not.toHaveBeenCalled();
  });

  it("shares the parent for auto and migrates the former saved default", async () => {
    control.mockReset().mockResolvedValue("");
    for (const mode of [undefined, "auto"] as const) {
      for (const value of ["auto", "2048"]) {
        expect(await resolvePiWorkloadMemory(mode, value, {}, "linux", 2 * gib)).toEqual({
          kind: "auto",
        });
      }
    }
    expect(await resolvePiWorkloadMemory("auto", "auto", {}, "linux", 8 * gib)).toEqual({
      kind: "auto",
    });
    expect(await resolvePiWorkloadMemory("on", "auto", {}, "linux", 16 * gib)).toEqual({
      kind: "auto",
    });
    expect(await resolvePiWorkloadMemory("auto", "384", {}, "linux", 2 * gib)).toEqual({
      kind: "explicit",
      mib: 384,
    });
  });

  it("fails closed for explicit protection when the manager is unavailable", async () => {
    control.mockReset().mockRejectedValue(new Error("user systemd unavailable"));
    expect(await resolvePiWorkloadMemory("auto", "auto", {}, "linux", 4 * gib)).toBeUndefined();
    await expect(resolvePiWorkloadMemory("on", "2048", {}, "linux", 4 * gib)).rejects.toThrow(
      "unavailable",
    );
    await expect(
      resolvePiWorkloadMemory(
        "off",
        "auto",
        { ROVE_PI_MEMORY_BUDGET_MIB: "384" },
        "linux",
        4 * gib,
      ),
    ).rejects.toThrow("unavailable");
  });

  it("preserves explicit settings and environment precedence", async () => {
    control.mockReset().mockResolvedValue("");
    expect(await resolvePiWorkloadMemory("on", "2048", {}, "linux", 2 * gib)).toEqual({
      kind: "explicit",
      mib: 2048,
    });
    expect(
      await resolvePiWorkloadMemory(
        "off",
        "auto",
        { ROVE_PI_MEMORY_BUDGET_MIB: "384" },
        "linux",
        2 * gib,
      ),
    ).toEqual({ kind: "explicit", mib: 384 });
    await expect(resolvePiWorkloadMemory("on", "383", {}, "linux", 4 * gib)).rejects.toThrow("384");
    await expect(resolvePiWorkloadMemory("on", "2048", {}, "darwin", 4 * gib)).rejects.toThrow(
      "Linux",
    );
    await expect(
      resolvePiWorkloadMemory(
        "off",
        "auto",
        { ROVE_PI_MEMORY_BUDGET_MIB: "auto" },
        "linux",
        4 * gib,
      ),
    ).rejects.toThrow();
  });
});
