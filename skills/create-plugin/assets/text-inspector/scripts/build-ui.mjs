import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({ entryPoints: [resolve(plugin, "ui/panel.mjs")], bundle: true, write: false,
  supported: { "template-literal": false }, platform: "browser", format: "iife", target: "es2022", minify: true, metafile: true });
if (bundle.outputFiles.length !== 1 || Object.values(bundle.metafile.outputs).some(output => output.imports.length))
  throw new Error("Expected one self-contained browser bundle");
const [template, styles] = await Promise.all([
  readFile(resolve(plugin, "ui/panel.template.html"), "utf8"), readFile(resolve(plugin, "ui/styles.css"), "utf8"),
]);
if (template.split("<!-- UI_SCRIPT -->").length !== 2 || template.split("/* UI_STYLES */").length !== 2)
  throw new Error("Expected exactly one script and stylesheet marker");
const script = bundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = template.replace("/* UI_STYLES */", () => styles).replace("<!-- UI_SCRIPT -->", () => `<script>${script}</script>`);
if (Buffer.byteLength(html) > 16 * 1024 * 1024) throw new Error("App exceeds the 16 MiB HTML limit");
await writeFile(resolve(plugin, "ui/panel.html"), html);
console.log("Built offline ui/panel.html with the official MCP Apps SDK");
