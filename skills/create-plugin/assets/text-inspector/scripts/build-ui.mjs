import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [template, sdk, panel] = await Promise.all([
  readFile(resolve(plugin, "ui/panel.template.html"), "utf8"),
  readFile(resolve(plugin, "ui/sdk.js"), "utf8"),
  readFile(resolve(plugin, "ui/panel.mjs"), "utf8"),
]);
const marker = "<!-- UI_SCRIPT -->";
if (template.split(marker).length !== 2) throw new Error("Expected exactly one UI_SCRIPT marker");
const script = (sdk + "\n;(() => {\n" + panel + "\n})();").replace(/<\/script/gi, "<\\/script");
const html = template.replace(marker, () => "<script>" + script + "</script>");
if (Buffer.byteLength(html, "utf8") > 2 * 1024 * 1024) throw new Error("UI exceeds the 2 MiB HTML limit");
await writeFile(resolve(plugin, "ui/panel.html"), html, "utf8");
console.log("Built ui/panel.html with the bundled browser SDK");
