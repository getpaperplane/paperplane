import type { Plugin } from "vite-plus";
import { homepage, htmlContent, publicFiles } from "../cloudflare/content";

export function hostedContentPlugin(origin: string): Plugin {
  return {
    name: "rove-hosted-content",
    transformIndexHtml(html) {
      // Real raw-HTML content, removed synchronously before paint for the existing
      // JS splash. Without JS, the overview remains visible instead of a dead logo.
      return html.replace(
        '<div id="root">',
        `<div id="root">\n<main id="hosted-overview">${htmlContent(homepage)}</main>\n<script>document.getElementById("hosted-overview").remove();</script>\n<noscript><style>#boot-shell { display: none; } #root { height: auto; }</style></noscript>`,
      );
    },
    generateBundle() {
      for (const [fileName, source] of Object.entries(publicFiles(origin))) {
        this.emitFile({ type: "asset", fileName, source });
      }
    },
  };
}
