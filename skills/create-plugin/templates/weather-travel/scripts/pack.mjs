import { readFile, writeFile, readdir, lstat } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { validate } from "./validate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = await validate(root);
const zip = new JSZip();
let total = 0, count = 0;
async function add(file) {
  const path = join(root, file), stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error("Refusing links in plugin archive");
  if (stat.isDirectory()) { for (const child of (await readdir(path)).sort()) await add(`${file}/${child}`); return; }
  if (!stat.isFile() || ++count > 5000 || (total += stat.size) > 250 * 1024 * 1024) throw new Error("Plugin archive limit exceeded");
  zip.file(`${manifest.name}/${file}`, await readFile(path), { date: new Date("2000-01-01T00:00:00Z"), unixPermissions: 0o100644, createFolders: false });
}
for (const file of [".vykor-plugin", "ui/apps.json", "skills", "LICENSE", "README.md", "dist/ui", ...(manifest.components.tools ? ["dist/native"] : ["dist/server.mjs", "mcp.json"])]) await add(file);
const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", platform: "UNIX", compressionOptions: { level: 9 } });
if (bytes.length > 100 * 1024 * 1024) throw new Error("Compressed plugin archive limit exceeded");
const file = `dist/${manifest.name}-${manifest.version}.zip`;
await writeFile(join(root, file), bytes);
await writeFile(join(root, `${file}.sha256`), `${createHash("sha256").update(bytes).digest("hex")}  ${manifest.name}-${manifest.version}.zip\n`);
console.log(`Packaged ${file} (${bytes.length} bytes), checksum recorded beside archive`);
