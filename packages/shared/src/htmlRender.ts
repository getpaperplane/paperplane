/**
 * Interactive pages ("HTML renders") an agent publishes with the `html_render`
 * MCP tool. The server stores each page as a thread attachment with a small
 * bootstrap in its head; clients load it into a sandboxed frame (web, desktop)
 * or WebView (mobile) and hand it the active theme as CSS custom properties.
 *
 * The bootstrap speaks the MCP Apps message shapes (JSON-RPC over
 * postMessage) so the same host code can later drive MCP apps:
 * https://github.com/modelcontextprotocol/ext-apps
 */

import { HTML_RENDER_MAX_HEIGHT, HTML_RENDER_MIN_HEIGHT } from "@rove-code/contracts/rich-response";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const HTML_RENDER_TOOL_NAME = "html_render";

/** The theme a client hands a page: its appearance and CSS custom properties. */
export interface HtmlRenderTheme {
  readonly appearance: "light" | "dark";
  readonly variables: Readonly<Record<string, string>>;
}

/** Variables every client provides, documented for agents in the tool description. */
export const HTML_RENDER_THEME_VARIABLES = [
  "--background",
  "--foreground",
  "--muted",
  "--muted-foreground",
  "--card",
  "--card-foreground",
  "--border",
  "--primary",
  "--primary-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--warning",
  "--success",
  "--info",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--radius",
  "--font-sans",
  "--font-mono",
] as const;

/** Categorical chart colors; the app has no chart tokens of its own. */
const HTML_RENDER_CHART_COLORS = {
  light: ["#2563eb", "#0d9488", "#d97706", "#9333ea", "#e11d48"],
  dark: ["#60a5fa", "#2dd4bf", "#fbbf24", "#c084fc", "#fb7185"],
} as const;

const FONT_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const FONT_MONO = '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';

const FALLBACK_THEMES = {
  dark: {
    appearance: "dark",
    variables: {
      "--background": "#0a0a0a",
      "--foreground": "#f5f5f5",
      "--muted": "#1c1c1c",
      "--muted-foreground": "#a3a3a3",
      "--card": "#131313",
      "--card-foreground": "#f5f5f5",
      "--border": "#2a2a2a",
      "--primary": "#5b7cfa",
      "--primary-foreground": "#ffffff",
      "--accent": "#262626",
      "--accent-foreground": "#f5f5f5",
      "--destructive": "#f87171",
      "--warning": "#fbbf24",
      "--success": "#34d399",
      "--info": "#60a5fa",
      ...chartVariables("dark"),
      "--radius": "0.625rem",
      "--font-sans": FONT_SANS,
      "--font-mono": FONT_MONO,
    },
  },
  light: {
    appearance: "light",
    variables: {
      "--background": "#fcfcfc",
      "--foreground": "#27272a",
      "--muted": "#f7f7f8",
      "--muted-foreground": "#71717a",
      "--card": "#ffffff",
      "--card-foreground": "#27272a",
      "--border": "#e4e4e7",
      "--primary": "#3b5bdb",
      "--primary-foreground": "#ffffff",
      "--accent": "#f4f4f5",
      "--accent-foreground": "#18181b",
      "--destructive": "#dc2626",
      "--warning": "#d97706",
      "--success": "#059669",
      "--info": "#2563eb",
      ...chartVariables("light"),
      "--radius": "0.625rem",
      "--font-sans": FONT_SANS,
      "--font-mono": FONT_MONO,
    },
  },
} satisfies Record<HtmlRenderTheme["appearance"], HtmlRenderTheme>;

export function chartVariables(appearance: HtmlRenderTheme["appearance"]) {
  return Object.fromEntries(
    HTML_RENDER_CHART_COLORS[appearance].map((color, index) => [`--chart-${index + 1}`, color]),
  );
}

/** Agent-facing description of the theme and layout a page renders into. */
export const HTML_RENDER_PAGE_GUIDE = [
  "Rove injects its active theme as CSS custom properties on :root that follow the user's theme and light/dark mode live:",
  `${HTML_RENDER_THEME_VARIABLES.join(", ")}.`,
  "The base stylesheet sets html background, color and font from these and body margin to 0; your CSS overrides it.",
  "The page sits inline in the reply column (about 720px wide on desktop, 360px on phones) on the thread's own background,",
  "so leave html and body without a background, use a fluid width, and skip outer cards, borders, and banner titles.",
  "Give charts fixed pixel heights. Avoid 100vh or height:100% on html or body: the frame grows to fit the page.",
].join(" ");

// Messages between a page and its client.
const HOST_CONTEXT_CHANGED_METHOD = "ui/notifications/host-context-changed";
const OPEN_LINK_METHOD = "ui/open-link";
const SIZE_CHANGED_METHOD = "ui/notifications/size-changed";
const THEME_FRAGMENT_KEY = "rove-theme";

export function clampHtmlRenderHeight(height: number): number {
  return Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(height)));
}

const SizeChangedMessage = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  method: Schema.Literal(SIZE_CHANGED_METHOD),
  params: Schema.Struct({ height: Schema.Finite.check(Schema.isGreaterThan(0)) }),
});
const OpenLinkMessage = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  method: Schema.Literal(OPEN_LINK_METHOD),
  params: Schema.Struct({ url: Schema.String.check(Schema.isPattern(/^https?:\/\//i)) }),
});
// React Native's WebView delivers messages as JSON strings.
const decodeSizeChanged = Schema.decodeUnknownOption(
  Schema.Union([SizeChangedMessage, Schema.fromJsonString(SizeChangedMessage)]),
);
const decodeOpenLink = Schema.decodeUnknownOption(
  Schema.Union([OpenLinkMessage, Schema.fromJsonString(OpenLinkMessage)]),
);

/** The content height a page reported, if `data` is its size notification. */
export function readHtmlRenderContentHeight(data: unknown): number | undefined {
  return Option.getOrUndefined(decodeSizeChanged(data))?.params.height;
}

/** The http(s) URL a page asked its client to open, if `data` is that request. */
export function readHtmlRenderLinkRequest(data: unknown): string | undefined {
  return Option.getOrUndefined(decodeOpenLink(data))?.params.url;
}

/** URL fragment that themes a page before its first paint. */
export function htmlRenderThemeFragment(theme: HtmlRenderTheme): string {
  return `#${THEME_FRAGMENT_KEY}=${encodeURIComponent(JSON.stringify(theme))}`;
}

/** The notification a client posts into a mounted page when its theme changes. */
export function htmlRenderThemeMessage(theme: HtmlRenderTheme) {
  return {
    jsonrpc: "2.0",
    method: HOST_CONTEXT_CHANGED_METHOD,
    params: { theme: theme.appearance, styles: { variables: theme.variables } },
  } as const;
}

const BASE_CSS =
  "html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}" +
  "html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}" +
  "img,video,canvas,svg{max-width:100%}";

function rootRule(theme: HtmlRenderTheme): string {
  const declarations = Object.entries(theme.variables)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  return `:root{color-scheme:${theme.appearance};${declarations}}`;
}

// Runs synchronously in <head>, before the page's own styles and body, so the
// first paint is themed. It rewrites its own <style> element rather than
// setting inline properties, so a page's later `:root` rules still win, then
// drops the fragment so a page's own hash routing never sees it. Links never
// replace the page inside the thread: the client opens them in the browser.
// The page reports its content height so the client can fit the frame to it.
// Inside React Native's WebView the page is top-level and talks through
// `window.ReactNativeWebView` instead of its parent.
const BOOTSTRAP_SCRIPT = `(function(){var s=document.getElementById("rove-theme"),n=0,w=window.ReactNativeWebView;if(!s)return;var b=${JSON.stringify(BASE_CSS)};function post(m){if(w)w.postMessage(JSON.stringify(m));else if(window.parent!==window)window.parent.postMessage(m,"*");}function a(t){if(!t||typeof t!=="object"||!t.variables||typeof t.variables!=="object")return;var c=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";for(var k in t.variables){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(t.variables[k]).replace(/[;{}<>]/g,"")+";";}s.textContent=c+"}"+b;}try{var m=/[#&]${THEME_FRAGMENT_KEY}=([^&]*)/.exec(location.hash);if(m){a(JSON.parse(decodeURIComponent(m[1])));history.replaceState(history.state,"",location.pathname+location.search);}}catch(e){}window.addEventListener("message",function(e){var d=e.data;if(typeof d==="string"){try{d=JSON.parse(d);}catch(x){return;}}var p=d&&d.params;if(d&&d.jsonrpc==="2.0"&&d.method===${JSON.stringify(HOST_CONTEXT_CHANGED_METHOD)}&&p&&p.styles)a({appearance:p.theme,variables:p.styles.variables});});document.addEventListener("click",function(e){var l=e.isTrusted?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null,u;if(!l)return;try{u=new URL(l.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol)||u.href.split("#")[0]===location.href.split("#")[0])return;if(w||window.parent!==window){e.preventDefault();post({jsonrpc:"2.0",id:"rove-link-"+(++n),method:${JSON.stringify(OPEN_LINK_METHOD)},params:{url:u.href}});}else{l.setAttribute("target","_blank");l.setAttribute("rel","noopener");}},true);if(w||window.parent!==window){var h,o,z=function(){var r=document.documentElement,v=Math.ceil(r.getBoundingClientRect().height);if(!v||v===h)return;h=v;post({jsonrpc:"2.0",method:${JSON.stringify(SIZE_CHANGED_METHOD)},params:{height:v}});};if(window.ResizeObserver){o=new ResizeObserver(z);o.observe(document.documentElement);}document.addEventListener("DOMContentLoaded",function(){if(o&&document.body)o.observe(document.body);z();});window.addEventListener("load",z);}})();`;

function bootstrapMarkup(markup: string): string {
  // Opened without a client theme (a download), the page follows the OS.
  const defaultCss = `${rootRule(FALLBACK_THEMES.dark)}@media (prefers-color-scheme: light){${rootRule(FALLBACK_THEMES.light)}}${BASE_CSS}`;
  return [
    /<meta\s[^>]*charset/i.test(markup.slice(0, 4096)) ? "" : '<meta charset="utf-8">',
    /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(markup)
      ? ""
      : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="rove-theme">${defaultCss}</style>`,
    `<script>${BOOTSTRAP_SCRIPT}</script>`,
  ].join("");
}

// Comments and raw-text elements are blanked to the same length, so offsets
// still line up and a `<head>` inside a script or comment is never matched.
const blankNonMarkup = (html: string) =>
  html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|template|xmp|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/gi,
    (match) => " ".repeat(match.length),
  );

/**
 * Inserts the theme bootstrap at the start of the document head so the page's
 * own styles and scripts come after it. Fragments get a minimal document.
 */
export function injectHtmlRenderBootstrap(html: string): string {
  const scan = blankNonMarkup(html);
  const bootstrap = bootstrapMarkup(scan);
  const head = /<head\b[^>]*>/i.exec(scan);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + bootstrap + html.slice(at);
  }
  const root = /<html\b[^>]*>/i.exec(scan);
  if (root) {
    const at = root.index + root[0].length;
    return `${html.slice(0, at)}<head>${bootstrap}</head>${html.slice(at)}`;
  }
  // A fragment without a doctype would render in quirks mode.
  const doctype = /^\s*<!doctype[^>]*>/i.exec(scan);
  const at = doctype ? doctype[0].length : 0;
  return `${doctype ? html.slice(0, at) : "<!doctype html>"}<html><head>${bootstrap}</head><body>${html.slice(at)}</body></html>`;
}

/** A readable download name: the title without characters file systems reject. */
export function htmlRenderFileName(title: string): string {
  const name = title
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  return `${name || "Page"}.html`;
}
