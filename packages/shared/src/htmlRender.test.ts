import { describe, expect, it } from "vite-plus/test";
import {
  htmlRenderThemeFragment,
  injectHtmlRenderBootstrap,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
} from "./htmlRender.ts";

const BOOTSTRAP = '<style id="rove-theme">';

describe("injectHtmlRenderBootstrap", () => {
  it("goes first in the head so the page's own styles win", () => {
    const page = injectHtmlRenderBootstrap(
      "<!doctype html><html><head><style>:root{--x:1}</style></head><body>Hi</body></html>",
    );
    expect(page.indexOf(BOOTSTRAP)).toBeGreaterThan(page.indexOf("<head>"));
    expect(page.indexOf(BOOTSTRAP)).toBeLessThan(page.indexOf(":root{--x:1}"));
    expect(page).toContain('<meta charset="utf-8">');
  });

  it("ignores head tags inside comments and scripts", () => {
    const page = injectHtmlRenderBootstrap(
      "<!doctype html><html><!-- <head> --><script>'<head>'</script><head></head></html>",
    );
    expect(page.indexOf(BOOTSTRAP)).toBeGreaterThan(page.lastIndexOf("<head>"));
  });

  it("wraps a fragment in a standards-mode document", () => {
    const page = injectHtmlRenderBootstrap("<canvas></canvas>");
    expect(page.startsWith("<!doctype html><html><head>")).toBe(true);
    expect(page).toContain("<body><canvas></canvas></body>");
  });

  it("keeps a page's own charset and viewport", () => {
    const page = injectHtmlRenderBootstrap(
      '<html><head><meta charset="latin1"><meta name="viewport" content="width=500"></head></html>',
    );
    expect(page).not.toContain('<meta charset="utf-8">');
    expect(page.match(/name="viewport"/g)).toHaveLength(1);
  });
});

describe("page messages", () => {
  it("reads sizes and http(s) links from objects and React Native strings", () => {
    const size = {
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: 412 },
    };
    expect(readHtmlRenderContentHeight(size)).toBe(412);
    expect(readHtmlRenderContentHeight(JSON.stringify(size))).toBe(412);
    expect(readHtmlRenderContentHeight({ ...size, params: { height: -1 } })).toBeUndefined();

    const link = (url: string) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/open-link",
      params: { url },
    });
    expect(readHtmlRenderLinkRequest(link("https://example.com"))).toBe("https://example.com");
    expect(readHtmlRenderLinkRequest(link("javascript:alert(1)"))).toBeUndefined();
  });

  it("encodes the theme into a fragment the bootstrap can read", () => {
    const fragment = htmlRenderThemeFragment({
      appearance: "light",
      variables: { "--background": "#fff" },
    });
    expect(fragment.startsWith("#rove-theme=")).toBe(true);
    expect(JSON.parse(decodeURIComponent(fragment.slice("#rove-theme=".length)))).toEqual({
      appearance: "light",
      variables: { "--background": "#fff" },
    });
  });
});
