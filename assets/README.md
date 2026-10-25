# Brand icons

`prod/logo.png` is the official Paperplane logo: the original, transparent 2000×2000
paper-textured plane supplied by the maintainer. Preserve its shape, colors, texture,
and black outline. Do not replace it with a lettermark or apply glass/material effects.
`prod/logo.svg` is a wrapper around that raster artwork, not a vector recreation.

Run `vp run icons:export` from the repository root to regenerate the platform sizes,
Icon Composer logo layers, web favicons, marketing images, Android artwork, and iOS
widget template. Run `vp run icons:check` to verify all tracked derivatives without
modifying files. Both commands work on Linux, macOS, and Windows using Sharp; no
Icon Composer installation is required. Do not edit generated images directly.

Development and nightly retain their blueprint and night-sky backgrounds. All channels
use the same official mark. Existing export filenames are retained for build compatibility.
The Icon Composer projects are retained for native design inspection; their logo layers
are generated from the master, not separate artwork sources.

## Platform framing

- iOS icons are opaque, full-bleed squares; the operating system applies its own mask.
- macOS PNGs have an 824×824 rounded body inset 100px in a transparent 1024×1024 canvas.
- Windows ICOs include 16, 24, 32, 48, 64, 128, and 256px renditions.
- Web favicons and Apple touch icons are resized from the channel's full-color icon.
  The tracked `apps/web/public` copies use development branding; release builds select
  their channel through `scripts/apply-web-brand-assets.ts`. Marketing uses production.
- Android launcher foregrounds and Android 12+ splash marks fit inside the circular safe
  zone. Backgrounds remain full bleed. `vp run icons:export:android` regenerates just
  those foreground, background, and splash assets.
- Android themed launcher/notification icons and the iOS widget template use a white
  silhouette derived from the official artwork's alpha channel, as required by the OS.
