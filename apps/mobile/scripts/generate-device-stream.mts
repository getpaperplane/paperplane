import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "vite-plus";

const mobileRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

/**
 * noVNC's browser.js probes H.264 support with a top-level await, which Rollup
 * rejects for an IIFE. The result only gates an optional encoding negotiated
 * after the socket connects, so setting it when the probe settles is equivalent.
 */
const noVncTopLevelAwait = {
  name: "rove-novnc-top-level-await",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (!/@novnc[\\/]novnc[\\/]core[\\/]util[\\/]browser\.js$/.test(id)) return null;
    const probe = "supportsWebCodecsH264Decode = await _checkWebCodecsH264DecodeSupport();";
    if (!code.includes(probe)) {
      throw new Error("noVNC changed its H.264 probe; update rove-novnc-top-level-await.");
    }
    return code.replace(
      probe,
      "_checkWebCodecsH264DecodeSupport().then((supported) => { supportsWebCodecsH264Decode = supported; }, () => {});",
    );
  },
};

/** Metro embeds each shared browser transport as a small script in a native WebView. */
async function generateWebViewScript(feature: string, name: string) {
  const stem = `${name.toLowerCase()}-stream`;
  const result = await build({
    configFile: false,
    logLevel: "silent",
    plugins: [noVncTopLevelAwait],
    build: {
      write: false,
      target: "es2022",
      minify: true,
      lib: {
        entry: NodePath.join(mobileRoot, "src/features", feature, `${stem}.browser.ts`),
        name: `Rove${name}Stream`,
        formats: ["iife"],
      },
    },
  });
  const bundles = Array.isArray(result) ? result : [result];
  const chunk = bundles
    .flatMap((bundle) => ("output" in bundle ? bundle.output : []))
    .find((output) => output.type === "chunk");
  if (!chunk) throw new Error(`${name} build did not emit a script.`);
  const root = NodePath.join(mobileRoot, ".generated", stem);
  await NodeFSP.mkdir(root, { recursive: true });
  for (const [file, contents] of [
    ["index.js", `module.exports = ${JSON.stringify(chunk.code)};\n`],
    ["package.json", '{"main":"index.js"}\n'],
  ] as const) {
    const destination = NodePath.join(root, file);
    const previous = await NodeFSP.readFile(destination, "utf8").catch(() => null);
    if (previous !== contents) await NodeFSP.writeFile(destination, contents);
  }
}

export const generateDeviceStreamScript = () => generateWebViewScript("devices", "Device");
export const generateDesktopStreamScript = () => generateWebViewScript("devices", "Desktop");
export const generatePreviewStreamScript = () => generateWebViewScript("browser", "Preview");
