import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import sharp from "sharp";
import { describe, expect, it } from "vite-plus/test";

import { renderForeground } from "./export-android-icons.ts";

const render = (size: number) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const repositoryRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
    return yield* renderForeground(repositoryRoot, size);
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

describe("Android Paperplane foreground", () => {
  it.each([432, 1152])(
    "renders the Paperplane mark inside the circular mask at %spx",
    async (size) => {
      // Render the official artwork, not an obsolete lettermark or a masked app tile.
      const png = await render(size);
      const { data, info } = await sharp(png)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect([info.width, info.height]).toEqual([size, size]);

      let left = size;
      let top = size;
      let right = -1;
      let bottom = -1;
      const center = (size - 1) / 2;
      const safeRadius = (size * 66) / 108 / 2;
      let furthestPixel = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (data[(y * size + x) * info.channels + 3] === 0) continue;
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
          furthestPixel = Math.max(furthestPixel, Math.hypot(x - center, y - center));
        }
      }
      expect(furthestPixel).toBeLessThan(safeRadius);
      expect(right).toBeGreaterThan(left);
      // The uploaded paper plane is wider than tall and retains its original proportions.
      expect((right - left) / (bottom - top)).toBeCloseTo(1812 / 1277, 1);
      expect(Math.abs(left + right - (size - 1))).toBeLessThanOrEqual(2);
      expect(Math.abs(top + bottom - (size - 1))).toBeLessThanOrEqual(2);
    },
  );
});
