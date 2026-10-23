import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, chmod } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyOfficialSkills } from './verify-official-skills.mjs';

const defaultRoot = fileURLToPath(new URL('..', import.meta.url));
const canonicalEngine = fileURLToPath(new URL('../../../packages/services/src/office/office-engine.mjs', import.meta.url));
const MAX_BINARY_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 250 * 1024 * 1024;

async function verifiedSize(path, expected) {
  let info;
  try { info = await stat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!info.isFile() || info.size > MAX_BINARY_BYTES) throw Error('Invalid OfficeCLI binary: ' + path);
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  if (hash.digest('hex') !== expected) throw Error('OfficeCLI SHA-256 mismatch: ' + path);
  return info.size;
}

export async function prepareEngineModule({ pluginRoot = defaultRoot } = {}) {
  await mkdir(join(pluginRoot, 'tools'), { recursive: true });
  await copyFile(canonicalEngine, join(pluginRoot, 'tools/office-engine.mjs'));
}

export async function ensureVerifiedBinary({ name, sha256, version, binDir, cacheDir, fetcher = fetch }) {
  const target = join(binDir, name);
  const existing = await verifiedSize(target, sha256);
  if (existing !== undefined) return { name, bytes: existing };
  await mkdir(cacheDir, { recursive: true });
  const cached = join(cacheDir, name);
  let bytes = await verifiedSize(cached, sha256);
  if (bytes === undefined) {
    const temporary = cached + '.' + randomUUID() + '.tmp';
    try {
      const response = await fetcher(`https://github.com/iOfficeAI/OfficeCLI/releases/download/v${version}/${name}`, { signal: AbortSignal.timeout(180000) });
      if (!response.ok || !response.body) throw Error(`OfficeCLI download failed (${response.status}): ${name}`);
      const hash = createHash('sha256');
      let size = 0;
      const inspect = new Transform({ transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > MAX_BINARY_BYTES) return callback(Error('OfficeCLI binary exceeds 64 MiB: ' + name));
        hash.update(chunk); callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), inspect, createWriteStream(temporary, { flags: 'wx' }));
      if (hash.digest('hex') !== sha256) throw Error('OfficeCLI SHA-256 mismatch: ' + name);
      await rename(temporary, cached);
      bytes = size;
    } finally { await rm(temporary, { force: true }); }
  }
  await mkdir(binDir, { recursive: true });
  const staging = target + '.' + randomUUID() + '.tmp';
  try {
    await copyFile(cached, staging);
    await verifiedSize(staging, sha256);
    await chmod(staging, 0o755);
    await rename(staging, target);
  } finally { await rm(staging, { force: true }); }
  return { name, bytes };
}

export async function prepareRelease({ pluginRoot = defaultRoot } = {}) {
  await verifyOfficialSkills(pluginRoot);
  for (const file of ['LICENSE', 'licenses/OFFICECLI-LICENSE', 'licenses/ORKAS-LICENSE']) await readFile(join(pluginRoot, file));
  const manifest = JSON.parse(await readFile(join(pluginRoot, '.vykor-plugin/plugin.json'), 'utf8'));
  const metadata = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'));
  if (manifest.version !== metadata.version) throw Error('Plugin and package versions differ');
  const { OFFICE_ASSETS, OFFICE_VERSION } = await import(pathToFileURL(canonicalEngine));
  const cacheDir = join(process.env.OFFICECLI_CACHE_DIR || join(homedir(), '.cache/vykor-officecli'), 'v' + OFFICE_VERSION);
  const binaries = [];
  for (const [platform, [name, sha256]] of Object.entries(OFFICE_ASSETS)) {
    const result = await ensureVerifiedBinary({ name, sha256, version: OFFICE_VERSION, binDir: join(pluginRoot, 'bin'), cacheDir });
    binaries.push({ platform, ...result });
    console.log(`Verified ${platform}: ${name} (${result.bytes} bytes)`);
  }
  const total = binaries.reduce((sum, asset) => sum + asset.bytes, 0);
  if (total >= MAX_EXPANDED_BYTES) throw Error('OfficeCLI binaries exceed the 250 MiB expanded plugin limit');
  await prepareEngineModule({ pluginRoot });
  await verifyOfficialSkills(pluginRoot);
  return { version: OFFICE_VERSION, binaries, binaryBytes: total };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const release = await prepareRelease();
  console.log(`Prepared OfficeCLI v${release.version}: ${release.binaries.length} platforms, ${release.binaryBytes} binary bytes. Ready for marketplace packaging.`);
}
