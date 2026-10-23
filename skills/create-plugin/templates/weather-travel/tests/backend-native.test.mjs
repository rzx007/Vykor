import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, names } from '../src/identity.mjs';

const enabled = config.backend === 'native' || process.env.WEATHER_TEST_ALL_BACKENDS === '1';
test('native tools use invocation host binding, split permissions by group, and return app data', { skip: !enabled }, async t => {
  const network = await import('../adapters/native/network.mjs'), data = await import('../adapters/native/data.mjs'), exporter = await import('../adapters/native/export.mjs');
  const base = await mkdtemp(join(tmpdir(), 'weather-native-')), cwd = join(base, 'workspace'); await mkdir(cwd);
  const context = { plugin: { dataDir: join(base, 'data') }, sessionId: 'native-session', cwd, signal: new AbortController().signal };
  const tools = [...network.registerTools(), ...data.registerTools(), ...exporter.registerTools()];
  t.after(async () => { const module = await import('../adapters/native/shared.mjs'); module.closeNativeServices(); await rm(base, { recursive: true, force: true }); });
  assert.deepEqual(network.registerTools().map(t => t.name), [names.SearchPlaces, names.GetForecast]);
  assert.deepEqual(exporter.registerTools().map(t => t.name), [names.ExportPlan]);
  const call = async (key, input, override = context) => tools.find(tool => tool.name === names[key]).invoke(input, override);
  const read = await call('ReadPlan', {});
  assert.equal(read.metadata.appData.document.revision, 0); assert.deepEqual(JSON.parse(read.content[0].text), read.metadata.appData);
  const saved = await call('SavePlanDraft', {documentId:'trip',expectedRevision:0,operationId:'save',title:'Native trip',entries:[]});
  assert.equal(saved.metadata.appData.document.revision, 1);
  const exported = await call('ExportPlan', {documentId:'trip',expectedRevision:1,operationId:'export',path:'trip.json',format:'json'});
  assert.equal(exported.metadata.appData.saved,true); assert.equal(JSON.parse(await readFile(join(cwd,'trip.json'),'utf8')).title,'Native trip');
  const missing = await call('ReadPlan', {}, {...context,sessionId:undefined});
  assert.equal(missing.isError,true); assert.equal(missing.metadata.appData.code,'host_binding_missing');
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal((await call('ReadPlan', {}, {...context,signal:cancelled.signal})).isError,true);
});
