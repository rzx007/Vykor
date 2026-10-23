import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/service.mjs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const place = { id: '1816670', name: 'Beijing', country: 'China', latitude: 39.9, longitude: 116.4, timezone: 'Asia/Shanghai' };
const entry = { id: 'museum', date: '2026-10-24', title: 'Museum', notes: 'Take an umbrella', place };
const draft = (operationId, expectedRevision = 0, title = 'Weekend') => ({ documentId: 'trip', expectedRevision, operationId, title, entries: [entry] });
async function setup(t, extra = {}) {
  const base = await mkdtemp(join(tmpdir(), 'weather-service-'));
  const options = { dataDir: join(base, 'data'), sessionId: 'session/one', workspaceRoot: join(base, 'workspace'), ...extra };
  await mkdir(options.workspaceRoot, { recursive: true });
  const services = [];
  const create = options => { const service = createService(options); services.push(service); return service; };
  const service = create(options);
  t.after(async () => { for (const instance of services) instance.close(); await rm(base, { recursive: true, force: true }); });
  return { service, options, base, create };
}

test('revision, exact receipt deduplication, and received conflict draft survive restart', async t => {
  const { service, options, create } = await setup(t);
  assert.deepEqual((await service.readPlan()).document, { id: 'trip', revision: 0, title: 'My trip', entries: [] });
  const saved = await service.invoke('SavePlanDraft', draft('save-1'));
  assert.equal(saved.saved, true); assert.equal(saved.document.revision, 1);
  assert.deepEqual(await service.invoke('SavePlanDraft', draft('save-1')), { ...saved, duplicate: true });
  await assert.rejects(service.invoke('SavePlanDraft', draft('save-1', 0, 'changed')), { code: 'operation_id_reused' });
  assert.deepEqual(await service.invoke('GetOperation', { operationId: 'save-1' }), saved);
  const conflict = await service.invoke('SavePlanDraft', draft('conflict-1', 0, 'Unsaved edit'));
  assert.equal(conflict.saved, false); assert.equal(conflict.conflict, true);
  service.close();
  const reopened = create(options);
  assert.equal((await reopened.readPlan()).draft.title, 'Unsaved edit');
  assert.deepEqual(await reopened.invoke('GetOperation', { operationId: 'conflict-1' }), conflict);
  assert.deepEqual(await reopened.invoke('GetOperation', { operationId: 'unknown' }), { kind: 'receipt', operationId: 'unknown', status: 'missing' });
});

test('two connections cannot overwrite the same revision, sessions isolate plans, favorites are shared', async t => {
  const { service, options, create } = await setup(t);
  const peer = create(options), other = create({ ...options, sessionId: 'session/two' });
  const results = await Promise.all([service.invoke('SavePlanDraft', draft('a')), peer.invoke('SavePlanDraft', draft('b'))]);
  assert.equal(results.filter(r => r.saved).length, 1);
  assert.equal((await other.readPlan()).document.revision, 0);
  const fav = await service.invoke('SetFavorite', { expectedRevision: 0, operationId: 'favorite-1', place, enabled: true });
  assert.equal(fav.revision, 1); assert.deepEqual((await other.readFavorites()).places, [place]);
  const applied = await peer.invoke('ApplyPlanOperations', { documentId: 'trip', expectedRevision: 1, operationId: 'apply-1', operations: [{ type: 'remove', id: 'museum' }] });
  assert.deepEqual(applied.document.entries, []); assert.equal(applied.document.revision, 2);
});

test('independent host processes atomically compete for one revision without losing a receipt', async t => {
  const {service,options}=await setup(t);
  const workers=['process-a','process-b'].map(operationId=>{
    const child=fork(fileURLToPath(new URL('./fixtures/save-worker.mjs',import.meta.url)),[JSON.stringify(options),operationId],{stdio:['ignore','ignore','pipe','ipc']});
    t.after(()=>{if(child.connected)child.kill();});
    let output='';child.stderr.on('data',chunk=>output+=chunk);
    let resolveReady,rejectReady,resolveResult,rejectResult,resolveExit,rejectExit;
    const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
    const result=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
    const exited=new Promise((resolve,reject)=>{resolveExit=resolve;rejectExit=reject;});
    // All three promises are observed immediately, including startup failures.
    for(const promise of [ready,result,exited])promise.catch(()=>{});
    child.on('message',message=>{if(message.ready)resolveReady();if(message.result)resolveResult(message.result);if(message.error)rejectResult(new Error(JSON.stringify(message.error)));});
    const failed=error=>{rejectReady(error);rejectResult(error);rejectExit(error);};
    child.on('error',failed);child.on('exit',code=>{if(code)failed(new Error(output||`Worker exited ${code}`));else resolveExit();});
    return {child,ready,result,exited};
  });
  await Promise.race([Promise.all(workers.map(worker=>worker.ready)),new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Host process did not become ready')),5000);timer.unref();})]);
  for(const worker of workers)worker.child.send('save');
  const results=await Promise.all(workers.map(worker=>worker.result));
  await Promise.all(workers.map(worker=>worker.exited));
  assert.equal(results.filter(result=>result.saved).length,1);
  assert.equal(results.filter(result=>result.conflict).length,1);
  assert.equal((await service.readPlan()).document.revision,1);
  for(const result of results)assert.deepEqual(await service.invoke('GetOperation',{operationId:result.operationId}),result);
});

test('exports a checked revision into the real workspace and refuses overwrites, escape, and symlinks', async t => {
  const { service, options, base } = await setup(t);
  await service.invoke('SavePlanDraft', draft('initial'));
  const exp = { documentId: 'trip', expectedRevision: 1, operationId: 'export-1', path: 'trip.md', format: 'markdown', overwrite: false };
  const receipt = await service.invoke('ExportPlan', exp);
  assert.equal(receipt.saved, true); assert.match(await readFile(join(options.workspaceRoot, 'trip.md'), 'utf8'), /Museum/u);
  assert.deepEqual(await service.invoke('GetOperation', { operationId: 'export-1' }), receipt);
  assert.deepEqual(await service.invoke('ExportPlan', exp), { ...receipt, duplicate: true });
  await assert.rejects(service.invoke('ExportPlan', { ...exp, operationId: 'export-2' }), { code: 'file_exists' });
  const replacement = await service.invoke('ExportPlan', { ...exp, operationId: 'replace', overwrite: true, format: 'json' });
  assert.equal(replacement.saved, true);
  assert.equal(JSON.parse(await readFile(join(options.workspaceRoot, 'trip.md'), 'utf8')).revision, 1);
  await assert.rejects(service.invoke('ExportPlan', { ...exp, operationId: 'escape', path: '../escape.md' }), { code: 'unsafe_path' });
  await mkdir(join(base, 'outside'));
  try { await symlink(join(base, 'outside'), join(options.workspaceRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  await assert.rejects(service.invoke('ExportPlan', { ...exp, operationId: 'symlink', path: 'linked/escape.md' }), { code: 'unsafe_path' });
  await assert.rejects(service.invoke('ExportPlan', { ...exp, operationId: 'symlink-replace', path: 'linked/escape.md', overwrite: true }), { code: 'unsafe_path' });
  assert.equal((await service.invoke('GetOperation', { operationId: 'escape' })).status, 'missing');
  const stale = await service.invoke('ExportPlan', { ...exp, operationId: 'stale', expectedRevision: 0, path: 'old.json', format: 'json' });
  assert.equal(stale.saved, false); assert.equal(stale.conflict, true);
});

test('rejects missing host binding, unknown fields, huge args, invalid dates, and arbitrary place URLs', async t => {
  assert.throws(() => createService({ sessionId: 's', workspaceRoot: '.' }), { code: 'host_binding_missing' });
  const { service } = await setup(t);
  await assert.rejects(service.invoke('SavePlanDraft', { ...draft('x'), sessionId: 'injected' }), { code: 'invalid_input' });
  await assert.rejects(service.invoke('SavePlanDraft', { ...draft('x'), title: 'x'.repeat(66_000) }), { code: 'input_too_large' });
  await assert.rejects(service.invoke('SavePlanDraft', { ...draft('x'), entries: [{ ...entry, date: '2026-02-30' }] }), { code: 'invalid_input' });
  await assert.rejects(service.invoke('GetForecast', { place: { ...place, url: 'https://attacker.invalid' } }), { code: 'invalid_input' });
});

test('a published export whose receipt cannot be committed reports an unknown outcome', async t => {
  const { service, options } = await setup(t);
  const db = new DatabaseSync(join(options.dataDir, 'weather-travel.sqlite'));
  try { db.exec("CREATE TRIGGER reject_export_receipt BEFORE INSERT ON receipts WHEN NEW.operation_id='export-ambiguous' BEGIN SELECT RAISE(ABORT, 'simulated receipt storage failure'); END"); }
  finally { db.close(); }
  const input = { documentId: 'trip', expectedRevision: 0, operationId: 'export-ambiguous', path: 'trip.json', format: 'json' };
  await assert.rejects(service.invoke('ExportPlan', input), { code: 'operation_outcome_unknown' });
  assert.equal(JSON.parse(await readFile(join(options.workspaceRoot, 'trip.json'), 'utf8')).revision, 0);
  assert.equal((await service.invoke('GetOperation', { operationId: input.operationId })).status, 'missing');
});
