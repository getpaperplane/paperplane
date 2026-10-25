import { defineConfig } from "astro/config";

export default defineConfig({
  site: process.env.PAPERPLANE_MARKETING_SITE_URL || undefined,
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
