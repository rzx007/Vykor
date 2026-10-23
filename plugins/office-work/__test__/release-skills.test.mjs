import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { verifyOfficialSkills } from '../scripts/verify-official-skills.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const skills = ['officecli', 'officecli-docx', 'officecli-pptx', 'officecli-xlsx'];
function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [path, data] of entries) {
    const name = Buffer.from(path), packed = deflateRawSync(data), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 6); header.writeUInt16LE(8, 10);
    header.writeUInt32LE(crc, 16); header.writeUInt32LE(packed.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42);
    locals.push(local, name, packed); central.push(header, name); offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
async function archive(t, extra = [], mutate = false, prefix = '') {
  const temp = await mkdtemp(join(tmpdir(), 'office-release-skills-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const paths = ['.vykor-plugin/plugin.json', 'vendor/officecli/SOURCE.json', ...skills.map(name => `vendor/officecli/skills/${name}/SKILL.md`)];
  const entries = await Promise.all(paths.map(async path => [path, await readFile(join(root, path))]));
  if (mutate) entries[2][1] = Buffer.concat([entries[2][1], Buffer.from('\nchanged\n')]);
  const path = join(temp, 'plugin.zip'); await writeFile(path, zip([...entries, ...extra].map(([name, bytes]) => [prefix + name, bytes])));
  return path;
}
test('official skill validation handles a universal plugin larger than an Office document', async t => {
  const path = await archive(t, [['bin/officecli-linux-x64', Buffer.alloc(65 * 1024 * 1024)]]);
  assert.deepEqual(await verifyOfficialSkills(root, path), skills);
});
test('packaged official skills still reject changed bodies', async t => {
  const path = await archive(t, [], true);
  await assert.rejects(() => verifyOfficialSkills(root, path), /hash mismatch/);
});
test('official skills can be verified in the marketplace single-root ZIP layout', async t => {
  const path = await archive(t, [], false, 'office-work/');
  assert.deepEqual(await verifyOfficialSkills(root, path), skills);
});
test('marketplace single-root archives still reject changed official bodies', async t => {
  const path = await archive(t, [], true, 'office-work/');
  await assert.rejects(() => verifyOfficialSkills(root, path), /hash mismatch/);
});
test('mixed archive roots cannot supply competing official source records', async t => {
  const path = await archive(t, [['other/vendor/officecli/SOURCE.json', await readFile(join(root, 'vendor/officecli/SOURCE.json'))]]);
  await assert.rejects(() => verifyOfficialSkills(root, path), /Invalid plugin release archive/);
});
