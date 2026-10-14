import { build } from "vite";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(plugin, "../../..");
if (process.argv.includes("--export-author-assets")) {
  const bundle = await build({
    configFile: false,
    plugins: [{ name: "browser-only-ui", generateBundle() {
      for (const id of this.getModuleIds()) {
        if (id.startsWith("node:") || id.includes("__vite-browser-external"))
          throw new Error("UI contains a Node dependency: " + id);
      }
    } }],
    build: { write: false, minify: "esbuild", target: "es2022",
      lib: { entry: resolve(root, "packages/plugins/src/ui-sdk.ts"), name: "VykorPluginUi", formats: ["iife"] } },
  });
  const chunks = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(result => result.output);
  if (chunks.length !== 1 || chunks[0].type !== "chunk") throw new Error("Expected one self-contained browser SDK");
  const styles = await readFile(resolve(root, "packages/plugins/src/ui-styles.css"), "utf8");
  for (const directory of [plugin, resolve(root, "skills/create-plugin/assets/text-inspector")]) {
    await writeFile(resolve(directory, "ui/sdk.js"), chunks[0].code, "utf8");
    await writeFile(resolve(directory, "ui/styles.css"), styles, "utf8");
  }
}
const [template, sdk, panel, styles] = await Promise.all([
  readFile(resolve(plugin, "ui/panel.template.html"), "utf8"),
  readFile(resolve(plugin, "ui/sdk.js"), "utf8"),
  readFile(resolve(plugin, "ui/panel.mjs"), "utf8"),
  readFile(resolve(plugin, "ui/styles.css"), "utf8"),
]);
const marker = "<!-- UI_SCRIPT -->";
if (template.split(marker).length !== 2 || template.split("/* UI_STYLES */").length !== 2)
  throw new Error("Expected exactly one script and stylesheet marker");
const script = (sdk + "\n;(() => {\n" + panel + "\n})();").replace(/<\/script/gi, "<\\/script");
const html = template.replace("/* UI_STYLES */", () => styles).replace(marker, () => "<script>" + script + "</script>");
if (Buffer.byteLength(html, "utf8") > 2 * 1024 * 1024) throw new Error("UI exceeds the 2 MiB HTML limit");
await writeFile(resolve(plugin, "ui/panel.html"), html, "utf8");
console.log("Built ui/panel.html from the current browser SDK");
