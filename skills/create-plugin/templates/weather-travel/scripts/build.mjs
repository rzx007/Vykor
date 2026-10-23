import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { configure } from "./configure.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(await readFile(resolve(root, "plugin.config.json"), "utf8"));
await configure(root);
await mkdir(resolve(root, "dist/ui"), { recursive: true });
const ui = await build({ entryPoints: [resolve(root, "ui/panel.mjs")], bundle: true, write: false,
  format: "iife", platform: "browser", target: "es2022", minify: true, metafile: true });
if (ui.outputFiles.length !== 1 || Object.values(ui.metafile.outputs).some(output => output.imports.length))
  throw new Error("Expected a self-contained offline App bundle");
const [template, styles] = await Promise.all(["panel.template.html", "styles.css"].map(file => readFile(resolve(root, "ui", file), "utf8")));
if (template.split("<!-- UI_SCRIPT -->").length !== 2 || template.split("/* UI_STYLES */").length !== 2)
  throw new Error("Expected exactly one script and style marker");
const script = ui.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = template.replace("/* UI_STYLES */", () => styles).replace("<!-- UI_SCRIPT -->", () => `<script>${script}</script>`);
if (Buffer.byteLength(html) > 16 * 1024 * 1024) throw new Error("App HTML exceeds host limit");
await writeFile(resolve(root, "dist/ui/panel.html"), html);
if (config.backend === "native") {
  for (const group of ["network", "data", "export"]) await build({ entryPoints: [resolve(root, `adapters/native/${group}.mjs`)],
    outfile: resolve(root, `dist/native/${group}.mjs`), bundle: true, platform: "node", target: "node24", format: "esm" });
} else {
  await build({ entryPoints: [resolve(root, "adapters/mcp/server.mjs")], outfile: resolve(root, "dist/server.mjs"),
    bundle: true, platform: "node", target: "node24", format: "esm",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
}
console.log(`Built ${config.backend} tools and offline MCP App for ${config.id}`);
