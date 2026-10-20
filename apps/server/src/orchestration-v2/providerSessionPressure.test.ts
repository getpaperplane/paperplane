import { assert, describe, it } from "@effect/vitest";
import { idleTimeoutForHost, isUnderMemoryPressure } from "./providerSessionPressure.ts";

const GIB = 1024 ** 3;

describe("provider session pressure", () => {
  it("uses five minutes through 8 GiB, thirty minutes above it", () => {
    for (const total of [4 * GIB, 8 * GIB]) assert.equal(idleTimeoutForHost(total), 300_000);
    for (const total of [8 * GIB + 1, 16 * GIB]) assert.equal(idleTimeoutForHost(total), 1_800_000);
  });

  it("requires at least 1 GiB available on small hosts", () => {
    for (const totalMemoryBytes of [2 * GIB, 4 * GIB]) {
      assert.isTrue(isUnderMemoryPressure({ totalMemoryBytes, availableMemoryBytes: GIB - 1 }));
      assert.isFalse(isUnderMemoryPressure({ totalMemoryBytes, availableMemoryBytes: GIB }));
      assert.isFalse(isUnderMemoryPressure({ totalMemoryBytes, availableMemoryBytes: GIB + 1 }));
    }
  });

  it("requires 15 percent available on larger hosts", () => {
    for (const totalMemoryBytes of [8 * GIB, 16 * GIB]) {
      const threshold = totalMemoryBytes * 0.15;
      assert.isTrue(
        isUnderMemoryPressure({ totalMemoryBytes, availableMemoryBytes: threshold - 1 }),
      );
      assert.isFalse(isUnderMemoryPressure({ totalMemoryBytes, availableMemoryBytes: threshold }));
      assert.isFalse(
        isUnderMemoryPressure({ totalMemoryBytes, availableMemoryBytes: threshold + 1 }),
      );
    }
  });
});
