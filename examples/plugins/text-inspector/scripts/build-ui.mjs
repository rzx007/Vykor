import { build } from "vite";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(plugin, "../../..");
const bundle = await build({
  configFile: false,
  resolve: { alias: { "@vykor/plugins/ui-sdk": resolve(root, "packages/plugins/src/ui-sdk.ts") } },
  plugins: [{ name: "browser-only-ui", generateBundle() {
    for (const id of this.getModuleIds()) {
      if (id.startsWith("node:") || id.includes("__vite-browser-external")) throw new Error("UI contains a Node dependency: " + id);
    }
  } }],
  build: { write: false, minify: "esbuild", target: "es2022",
    lib: { entry: resolve(plugin, "ui/panel.mjs"), name: "TextInspectorUi", formats: ["iife"] } },
});
const chunks = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(result => result.output);
if (chunks.length !== 1 || chunks[0].type !== "chunk") throw new Error("Expected one self-contained browser script");
const template = readFileSync(resolve(plugin, "ui/panel.template.html"), "utf8");
const script = chunks[0].code.replace(/<\/script/gi, "<\\/script");
writeFileSync(resolve(plugin, "ui/panel.html"), template.replace("<!-- UI_SCRIPT -->", "<script>" + script + "</script>"));
