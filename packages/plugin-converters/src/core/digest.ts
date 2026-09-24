import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function digestValue(value: unknown): string { return createHash("sha256").update(stable(value)).digest("hex"); }
async function files(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Source symlink is not allowed: ${relative(root, full)}`);
    if (entry.isDirectory()) out.push(...await files(root, full)); else if (entry.isFile()) out.push(full);
  }
  return out;
}
export async function digestSource(root: string): Promise<string> {
  if ((await lstat(root)).isSymbolicLink()) throw new Error("Source root link is not allowed");
  const hash = createHash("sha256");
  hash.update("vykor-source-v2\n");
  for (const file of await files(root)) {
    const content = await readFile(file);
    // Hash an unambiguous record: arbitrary binary bytes cannot impersonate file boundaries.
    hash.update(JSON.stringify([
      relative(root, file).replaceAll("\\", "/"),
      content.length,
      createHash("sha256").update(content).digest("hex"),
    ]));
    hash.update("\n");
  }
  return hash.digest("hex");
}
