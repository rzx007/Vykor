import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { listPackage } from '@electron/asar';

const { values } = parseArgs({ options: { artifact: { type: 'string' }, absent: { type: 'string' } } });
const directory = values.artifact ?? values.absent;
if (!directory || (values.artifact && values.absent)) {
  throw new Error('Usage: verify-cua-packaging.mjs --artifact|--absent <application resources directory>');
}

const resources = resolve(directory);
const archive = join(resources, 'app.asar');
const driverResource = /(?:^|[\\/])(?:computer-windows|cua-driver\.exe|driver-release\.json|CUA-LICENSE\.txt)(?:[\\/]|$)/i;
const archived = listPackage(archive).find(path => driverResource.test(path));
assert(archived === undefined, `Cua driver resource in app.asar: ${archived}`);

if (values.absent) {
  const loose = (await readdir(dirname(resources), { recursive: true })).find(path => driverResource.test(path));
  assert(loose === undefined, `Cua driver resource in packaged files: ${loose}`);
  console.log(`Confirmed the Cua driver is absent: ${resources}`);
} else {
  const driver = join(resources, 'computer-windows');
  const { verifyCuaDriverResources } = await import('../../../scripts/prepare-cua-driver.mjs');
  await verifyCuaDriverResources(driver);
  console.log(`Packaged Cua Driver checksum, architecture, Authenticode and license verified: ${driver}`);
}
