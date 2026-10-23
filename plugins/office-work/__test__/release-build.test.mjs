import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = new URL('../scripts/build.mjs', import.meta.url);
const sha256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'office-release-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'bin'));
  await mkdir(join(dir, 'cache'));
  // A missing build entry is the regression: a fresh market checkout cannot prepare its runtime.
  await assert.doesNotReject(() => access(script), 'independent Node build entry is required');
  const { ensureVerifiedBinary } = await import(script);
  return { dir, ensureVerifiedBinary, options: { name: 'officecli-linux-x64', sha256, version: '1.0.139', binDir: join(dir, 'bin'), cacheDir: join(dir, 'cache') } };
}
test('a verified cached binary prepares the plugin without a network request', async t => {
  const { dir, ensureVerifiedBinary, options } = await fixture(t);
  await writeFile(join(dir, 'cache', options.name), 'hello');
  const result = await ensureVerifiedBinary({ ...options, fetcher() { throw Error('network must not be used'); } });
  assert.equal(result.bytes, 5);
  assert.equal(await readFile(join(dir, 'bin', options.name), 'utf8'), 'hello');
});
test('corrupted cached binaries cannot enter a release', async t => {
  const { dir, ensureVerifiedBinary, options } = await fixture(t);
  await writeFile(join(dir, 'cache', options.name), 'tampered');
  await assert.rejects(() => ensureVerifiedBinary(options), /SHA-256/);
  assert.deepEqual(await readdir(join(dir, 'bin')), []);
});
test('downloads use the pinned release URL and reject corrupt bytes before publication', async t => {
  const { dir, ensureVerifiedBinary, options } = await fixture(t);
  await assert.rejects(() => ensureVerifiedBinary({ ...options, fetcher(url) {
    assert.equal(url, 'https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.139/officecli-linux-x64');
    return new Response('wrong bytes');
  } }), /SHA-256/);
  assert.deepEqual(await readdir(join(dir, 'bin')), []);
  assert.deepEqual(await readdir(join(dir, 'cache')), []);
});
test('verified downloads become reusable even if the plugin output is removed', async t => {
  const { dir, ensureVerifiedBinary, options } = await fixture(t);
  await ensureVerifiedBinary({ ...options, fetcher: async () => new Response('hello') });
  await rm(join(dir, 'bin', options.name));
  await ensureVerifiedBinary({ ...options, fetcher() { throw Error('download repeated'); } });
  assert.equal(await readFile(join(dir, 'bin', options.name), 'utf8'), 'hello');
});
test('offline engine preparation copies the canonical module without a desktop build', async t => {
  const { dir } = await fixture(t);
  const { prepareEngineModule } = await import(script);
  await prepareEngineModule({ pluginRoot: dir });
  const modulePath = join(dir, 'tools/office-engine.mjs');
  const bytes = await readFile(modulePath);
  assert.deepEqual(bytes, await readFile(new URL('../../../packages/services/src/office/office-engine.mjs', import.meta.url)));
  assert.equal((await import(pathToFileURL(modulePath))).OFFICE_VERSION, '1.0.139');
});
