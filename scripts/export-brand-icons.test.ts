import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import sharp from "sharp";
import { expect } from "vite-plus/test";

import { renderBrandAssets, renderBrandMark } from "./export-brand-icons.ts";
import { BRAND_ASSET_PATHS, resolveWebIconOverrides } from "./lib/brand-assets.ts";
import { readPngDimensions, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

it.layer(NodeServices.layer)("official Paperplane artwork exports", (it) => {
  it.effect("centers the visible artwork despite uneven transparent source margins", () =>
    Effect.gen(function* () {
      const source = yield* Effect.promise(async () => {
        const rectangle = await sharp({
          create: { width: 100, height: 50, channels: 4, background: "#f3ead0" },
        })
          .png()
          .toBuffer();
        return sharp({
          create: { width: 200, height: 200, channels: 4, background: "#00000000" },
        })
          .composite([{ input: rectangle, left: 10, top: 120 }])
          .png()
          .toBuffer();
      });
      const output = yield* renderBrandMark(source, 100);
      const { info } = yield* Effect.promise(() =>
        sharp(output).trim().toBuffer({ resolveWithObject: true }),
      );
      expect(info.width / info.height).toBeCloseTo(2, 1);
      expect(info.width).toBeLessThanOrEqual(84);
      expect(Math.abs((info.trimOffsetLeft ?? 0) * -2 + info.width - 100)).toBeLessThanOrEqual(2);
      expect(Math.abs((info.trimOffsetTop ?? 0) * -2 + info.height - 100)).toBeLessThanOrEqual(2);
    }),
  );

  it.effect(
    "exports the official mark with platform-safe framing and channel-specific copies",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
        const assets = yield* renderBrandAssets(root);

        for (const filename of [
          BRAND_ASSET_PATHS.developmentIosIconPng,
          BRAND_ASSET_PATHS.nightlyIosIconPng,
          BRAND_ASSET_PATHS.productionIosIconPng,
        ]) {
          const image = assets.get(filename)!;
          expect(readPngDimensions(image)).toEqual({ width: 1024, height: 1024 });
          expect((yield* Effect.promise(() => sharp(image).stats())).isOpaque).toBe(true);
          // Well inside the cream paper, not the channel background or the old blue lettermark.
          const { data } = yield* Effect.promise(() =>
            sharp(image)
              .extract({ left: 600, top: 600, width: 1, height: 1 })
              .removeAlpha()
              .raw()
              .toBuffer({ resolveWithObject: true }),
          );
          expect(data[0]).toBeGreaterThan(200);
          expect(data[1]).toBeGreaterThan(200);
          expect(data[2]).toBeGreaterThan(170);
        }

        for (const filename of [
          BRAND_ASSET_PATHS.developmentDesktopIconPng,
          BRAND_ASSET_PATHS.nightlyMacIconPng,
          BRAND_ASSET_PATHS.productionMacIconPng,
        ]) {
          const image = assets.get(filename)!;
          expect(readPngDimensions(image)).toEqual({ width: 1024, height: 1024 });
          const { data } = yield* Effect.promise(() =>
            sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
          );
          const alpha = (x: number, y: number) => data[(y * 1024 + x) * 4 + 3];
          expect(alpha(512, 99)).toBe(0);
          expect(alpha(512, 100)).toBe(255);
          expect(alpha(512, 923)).toBe(255);
          expect(alpha(512, 924)).toBe(0);
          expect(alpha(100, 100)).toBe(0);
        }

        const ico = assets.get(BRAND_ASSET_PATHS.productionWindowsIconIco)!;
        expect(ico.readUInt16LE(4)).toBe(WINDOWS_ICON_SIZES.length);
        WINDOWS_ICON_SIZES.forEach((size, index) => {
          const entry = 6 + index * 16;
          const length = ico.readUInt32LE(entry + 8);
          const offset = ico.readUInt32LE(entry + 12);
          expect(readPngDimensions(ico.subarray(offset, offset + length))).toEqual({
            width: size,
            height: size,
          });
        });

        for (const [brand, target] of [
          ["development", "apps/web/public"],
          ["production", "apps/marketing/public"],
        ] as const) {
          for (const override of resolveWebIconOverrides(brand, target)) {
            expect(assets.get(override.targetRelativePath)).toEqual(
              assets.get(override.sourceRelativePath),
            );
          }
        }
        const source = Buffer.from(
          yield* fs.readFile(path.join(root, BRAND_ASSET_PATHS.officialLogoPng)),
        );
        const mark = yield* renderBrandMark(source, 1024);
        for (const variant of ["dev", "nightly", "prod"]) {
          expect(assets.get(`assets/${variant}/app-icon.icon/Assets/logo.png`)).toEqual(mark);
        }
        const monochrome = assets.get("apps/mobile/assets/android-icon-mark.png")!;
        const alpha = yield* Effect.promise(() =>
          sharp(monochrome).extractChannel("alpha").raw().toBuffer(),
        );
        expect(alpha).toEqual(
          yield* Effect.promise(() => sharp(mark).extractChannel("alpha").raw().toBuffer()),
        );
        const pixels = yield* Effect.promise(() =>
          sharp(monochrome).ensureAlpha().raw().toBuffer(),
        );
        // Transparent RGB values are irrelevant; every visible color channel must be white.
        expect(
          pixels.every(
            (value, index) =>
              index % 4 === 3 || pixels[index - (index % 4) + 3] === 0 || value === 255,
          ),
        ).toBe(true);
      }),
  );
});
