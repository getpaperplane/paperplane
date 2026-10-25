#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import sharp from "sharp";

import { renderAndroidIcons, renderBackground } from "./export-android-icons.ts";
import {
  BRAND_ASSET_PATHS,
  resolveWebIconOverrides,
  resolveWebIconSourcePaths,
} from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

// Keep the uploaded artwork intact. All platform copies derive from this one master,
// without Icon Composer's glass/material effects recoloring the paper texture.
const MASTER = BRAND_ASSET_PATHS.officialLogoPng;
const VARIANTS = [
  {
    variant: "dev",
    brand: "development",
    ios: BRAND_ASSET_PATHS.developmentIosIconPng,
    macos: BRAND_ASSET_PATHS.developmentDesktopIconPng,
    universal: BRAND_ASSET_PATHS.developmentUniversalIconPng,
    windows: BRAND_ASSET_PATHS.developmentWindowsIconIco,
  },
  {
    variant: "nightly",
    brand: "nightly",
    ios: BRAND_ASSET_PATHS.nightlyIosIconPng,
    macos: BRAND_ASSET_PATHS.nightlyMacIconPng,
    universal: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
    windows: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
  },
  {
    variant: "prod",
    brand: "production",
    ios: BRAND_ASSET_PATHS.productionIosIconPng,
    macos: BRAND_ASSET_PATHS.productionMacIconPng,
    universal: BRAND_ASSET_PATHS.productionLinuxIconPng,
    windows: BRAND_ASSET_PATHS.productionWindowsIconIco,
  },
] as const;

export class IconExportRenderError extends Schema.TaggedError<IconExportRenderError>()(
  "IconExportRenderError",
  { cause: Schema.Defect() },
) {}

export class IconExportAssetsStaleError extends Schema.TaggedError<IconExportAssetsStaleError>()(
  "IconExportAssetsStaleError",
  { paths: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `Generated icon assets are stale:\n${this.paths.map((path) => `- ${path}`).join("\n")}`;
  }
}

/** Center the visible artwork, not the uneven transparent margins in the upload. */
export const renderBrandMark = (source: Buffer, size: number, fraction = 0.82) =>
  Effect.tryPromise({
    try: async () => {
      const markSize = Math.round(size * fraction);
      const mark = await sharp(source)
        .trim()
        .resize(markSize, markSize, { fit: "contain", background: "#00000000" })
        .png()
        .toBuffer();
      const inset = Math.floor((size - markSize) / 2);
      return sharp({ create: { width: size, height: size, channels: 4, background: "#00000000" } })
        .composite([{ input: mark, left: inset, top: inset }])
        .png()
        .toBuffer();
    },
    catch: (cause) => new IconExportRenderError({ cause }),
  });

const render = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new IconExportRenderError({ cause }) });

/** Render every tracked derivative so --check also covers marketing and native marks. */
export const renderBrandAssets = Effect.fn("iconExport.renderBrandAssets")(function* (
  repositoryRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = Buffer.from(yield* fs.readFile(path.join(repositoryRoot, MASTER)));
  const generated = new Map<string, Buffer>();
  const mark = yield* renderBrandMark(source, 1024);

  // Android's themed launcher and notification icons, and iOS's template widget,
  // need an alpha-only silhouette rather than the full-color paper texture.
  const silhouette = yield* render(async () => {
    const alpha = await sharp(mark).extractChannel("alpha").toBuffer();
    return sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#ffffff" } })
      .joinChannel(alpha)
      .png()
      .toBuffer();
  });
  generated.set("apps/mobile/assets/android-icon-mark.png", silhouette);
  generated.set(
    "apps/mobile/assets/android-notification-icon.png",
    yield* render(() => sharp(silhouette).resize(96, 96).png().toBuffer()),
  );
  const widget = yield* render(() => sharp(silhouette).resize(256, 256).png().toBuffer());
  generated.set(
    "apps/mobile/assets/widget/PaperplaneMark.svg",
    Buffer.from(
      `<svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">\n  <image width="256" height="256" href="data:image/png;base64,${widget.toString("base64")}"/>\n</svg>\n`,
    ),
  );

  for (const variant of VARIANTS) {
    generated.set(`assets/${variant.variant}/app-icon.icon/Assets/logo.png`, mark);
    const background = yield* renderBackground(repositoryRoot, variant.variant, 1024);
    const square = yield* render(() =>
      sharp(background)
        .composite([{ input: mark }])
        .flatten({ background: "#000000" })
        .png()
        .toBuffer(),
    );
    generated.set(variant.ios, square);
    generated.set(variant.universal, square);

    // Classic macOS icons occupy an 824px body on a transparent 1024px canvas.
    // Unlike iOS, the mask is baked into this desktop PNG, never the master.
    const body = yield* render(() => sharp(square).resize(824, 824).png().toBuffer());
    const mask = Buffer.from(
      '<svg width="824" height="824"><rect width="824" height="824" rx="185" fill="white"/></svg>',
    );
    const rounded = yield* render(() =>
      sharp(body)
        .ensureAlpha()
        .composite([{ input: mask, blend: "dest-in" }])
        .png()
        .toBuffer(),
    );
    generated.set(
      variant.macos,
      yield* render(() =>
        sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#00000000" } })
          .composite([{ input: rounded, left: 100, top: 100 }])
          .png()
          .toBuffer(),
      ),
    );

    const renditions = yield* Effect.forEach(WINDOWS_ICON_SIZES, (size) =>
      render(() => sharp(square).resize(size, size).png().toBuffer()).pipe(
        Effect.map((contents) => ({ size, contents })),
      ),
    );
    const ico = encodePngIco(renditions);
    generated.set(variant.windows, ico);
    const web = resolveWebIconSourcePaths(variant.brand);
    generated.set(web.faviconIco, ico);
    generated.set(web.favicon16Png, renditions.find((image) => image.size === 16)!.contents);
    generated.set(web.favicon32Png, renditions.find((image) => image.size === 32)!.contents);
    generated.set(
      web.appleTouchIconPng,
      yield* render(() => sharp(square).resize(180, 180).png().toBuffer()),
    );

    if (variant.variant === "prod" || variant.variant === "nightly") {
      generated.set(
        `apps/marketing/src/assets/icon${variant.variant === "nightly" ? "-nightly" : ""}.webp`,
        yield* render(() => sharp(square).webp({ quality: 90 }).toBuffer()),
      );
    }
    if (variant.variant === "prod") {
      generated.set("apps/marketing/public/icon.png", square);
    }
  }

  for (const [name, contents] of yield* renderAndroidIcons(repositoryRoot)) {
    generated.set(name, contents);
  }
  for (const [brand, target] of [
    ["development", "apps/web/public"],
    ["production", "apps/marketing/public"],
  ] as const) {
    for (const override of resolveWebIconOverrides(brand, target)) {
      const contents = generated.get(override.sourceRelativePath)!;
      generated.set(override.targetRelativePath, contents);
      if (target === "apps/marketing/public" && override.targetRelativePath.endsWith(".png")) {
        generated.set(
          override.targetRelativePath.replace(/\.png$/, ".webp"),
          yield* render(() => sharp(contents).webp({ quality: 90 }).toBuffer()),
        );
      }
    }
  }
  return generated;
});

export const exportBrandIcons = Effect.fn("exportBrandIcons")(function* (checkOnly: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const generated = yield* renderBrandAssets(repositoryRoot);
  const stale: string[] = [];
  for (const [relativePath, contents] of generated) {
    const target = path.join(repositoryRoot, relativePath);
    if (checkOnly) {
      if (
        !(yield* fs.exists(target)) ||
        !Buffer.from(yield* fs.readFile(target)).equals(contents)
      ) {
        stale.push(relativePath);
      }
    } else {
      yield* fs.writeFile(target, contents);
    }
  }
  if (stale.length > 0) return yield* new IconExportAssetsStaleError({ paths: stale });
  yield* Console.log(
    `${checkOnly ? "Verified" : "Updated"} ${generated.size} brand assets from ${MASTER}.`,
  );
});

export const exportBrandIconsCommand = Command.make(
  "export-brand-icons",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDescription("Verify generated icon assets without modifying files."),
      Flag.withDefault(false),
    ),
  },
  ({ check }) => exportBrandIcons(check),
).pipe(Command.withDescription("Resize the official Paperplane artwork for every app surface."));

if (import.meta.main) {
  Command.run(exportBrandIconsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
