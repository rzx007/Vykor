import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, '.vykor-plugin/plugin.json'), 'utf8'));
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (manifest.version !== metadata.version) throw Error('Plugin and package versions differ');
await readFile(join(root, 'LICENSE'));
for (const path of [...manifest.components.agents, ...manifest.components.skills]) {
  if (!(await stat(join(root, path))).isDirectory()) throw Error('Missing plugin component directory: ' + path);
}
for (const tool of manifest.components.tools) {
  const module = await import(new URL(tool.entry, new URL('../', import.meta.url)));
  if (typeof module.registerTools !== 'function') throw Error('Missing tool registration: ' + tool.entry);
}
console.log(`Prepared ${manifest.id}@${manifest.version}; no external runtime dependencies.`);
