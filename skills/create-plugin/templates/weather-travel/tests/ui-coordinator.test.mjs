import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanCoordinator, readToolValue, isNotAccepted } from '../ui/coordinator.mjs';
import { createService } from '../src/service.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const document = (revision = 0, title = '行程', entries = []) => ({ id: 'trip', revision, title, entries });
const result = value => ({ structuredContent: value });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const receipt = (input, revision = input.expectedRevision + 1) => result({ kind: 'plan', saved: true, operationId: input.operationId, document: document(revision, input.title, input.entries) });
const start = call => { const coordinator = createPlanCoordinator({ call, delay: 60_000 }); coordinator.receive({ kind: 'plan', document: document() }); return coordinator; };

test('autosave keeps one request in flight and coalesces edits made during it', async () => {
  const pending = deferred(), calls = [];
  const coordinator = start(async (key, input) => { calls.push([key, input]); return calls.length === 1 ? pending.promise : receipt(input); });
  coordinator.edit({ title: '第一版' });
  const saving = coordinator.save();
  coordinator.edit({ title: '第二版' }); coordinator.edit({ title: '最终版' });
  assert.equal(calls.length, 1);
  pending.resolve(receipt(calls[0][1])); await saving;
  assert.equal(coordinator.state.draft.title, '最终版');
  assert.equal(coordinator.state.status, 'dirty');
  await coordinator.save();
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1].expectedRevision, 1);
  assert.equal(calls[1][1].title, '最终版');
  assert.equal(coordinator.state.status, 'saved');
  coordinator.dispose();
});

test('only a receipt with the original operation and next revision confirms a save', async () => {
  for (const mode of ['wrong-operation', 'wrong-revision']) {
    const coordinator = start(async (_key, input) => mode === 'wrong-operation' ? result({ ...receipt(input).structuredContent, operationId: 'different' }) : receipt(input, 9));
    coordinator.edit({ title: '保留草稿' }); await coordinator.save();
    assert.equal(coordinator.state.status, 'unknown');
    assert.equal(coordinator.state.draft.title, '保留草稿');
    coordinator.dispose();
  }
});

test('unknown save queries only its original operation on explicit check and never replays', async () => {
  const calls = [];
  const coordinator = start(async (key, input) => { calls.push([key, input]); if (key === 'SavePlanDraft') throw new Error('connection lost'); return result({ kind: 'receipt', operationId: input.operationId, status: 'missing' }); });
  coordinator.edit({ title: '未确认' }); await coordinator.save();
  coordinator.edit({ title: '后续输入' }); await coordinator.save();
  assert.equal(calls.length, 1);
  await coordinator.check();
  assert.equal(calls[1][0], 'GetOperation');
  assert.equal(calls[1][1].operationId, calls[0][1].operationId);
  assert.equal(coordinator.state.status, 'unknown');
  assert.equal(coordinator.state.draft.title, '后续输入');
  coordinator.dispose();
});

test('late confirmation preserves newer input and makes it the next revision', async () => {
  let original;
  const coordinator = start(async (key, input) => { if (key === 'SavePlanDraft') { original = input; throw new Error('timeout'); } return receipt(original); });
  coordinator.edit({ title: '已送出' }); await coordinator.save();
  coordinator.edit({ title: '继续编辑' }); await coordinator.check();
  assert.equal(coordinator.state.document.revision, 1);
  assert.equal(coordinator.state.draft.title, '继续编辑');
  assert.equal(coordinator.state.status, 'dirty');
  coordinator.dispose();
});

test('remote changes retain local draft until explicit merge or adoption', async () => {
  const coordinator = start(async (_key, input) => receipt(input));
  coordinator.edit({ title: '本地稿' });
  coordinator.receive({ kind: 'plan', document: document(2, '新版') });
  assert.equal(coordinator.state.status, 'conflict');
  assert.equal(coordinator.state.draft.title, '本地稿');
  assert.equal(coordinator.state.latest.title, '新版');
  coordinator.merge();
  assert.equal(coordinator.state.document.revision, 2);
  assert.equal(coordinator.state.draft.title, '本地稿');
  await coordinator.save();
  assert.equal(coordinator.state.document.revision, 3);
  coordinator.edit({ title: '临时' });
  coordinator.receive({ kind: 'plan', document: document(4, '采用内容') });
  coordinator.adopt(3);
  assert.equal(coordinator.state.draft.title, '临时');
  coordinator.adopt(4);
  assert.equal(coordinator.state.draft.title, '采用内容');
  coordinator.dispose();
});

test('stored conflict draft is restored for comparison without replacing a current edit', () => {
  const coordinator = start(async () => {});
  coordinator.edit({ title: '仍在输入' });
  coordinator.receive({ kind: 'plan', document: document(3, '远端'), draft: { expectedRevision: 1, title: '收到的冲突稿', entries: [] } });
  assert.equal(coordinator.state.draft.title, '仍在输入');
  assert.equal(coordinator.state.recoveredDraft.title, '收到的冲突稿');
  assert.equal(coordinator.state.status, 'conflict');
  coordinator.dispose();
});

test('hidden state defers autosave and explicit receipt reads', async () => {
  const calls = [];
  const coordinator = start(async (key, input) => { calls.push(key); return receipt(input); });
  coordinator.setVisible(false); coordinator.edit({ title: '隐藏输入' }); await coordinator.save(); await coordinator.check();
  assert.deepEqual(calls, []);
  coordinator.setVisible(true); await coordinator.save();
  assert.deepEqual(calls, ['SavePlanDraft']);
  coordinator.dispose();
});

test('only standard notAccepted busy or hidden errors permit safe retry', async () => {
  assert.equal(isNotAccepted({ data: { code: 'plugin_app_busy', notAccepted: true } }), true);
  assert.equal(isNotAccepted({ data: { code: 'plugin_app_hidden', notAccepted: true } }), true);
  assert.equal(isNotAccepted({ code: 'plugin_app_busy', notAccepted: true }), false);
  assert.equal(isNotAccepted({ data: { code: 'plugin_app_busy' } }), false);
  const calls = [];
  const coordinator = start(async (_key, input) => { calls.push(input); if (calls.length === 1) throw { data: { code: 'plugin_app_busy', notAccepted: true } }; return receipt(input); });
  coordinator.edit({ title: '稍后保存' }); await coordinator.save();
  assert.equal(coordinator.state.status, 'dirty');
  await coordinator.save();
  assert.equal(coordinator.state.status, 'saved');
  assert.equal(calls[0].operationId, calls[1].operationId);
  coordinator.dispose();
});

test('selection waits for confirmed save and carries fixed document version and entry ids', async () => {
  const pending = deferred();
  const coordinator = start(async () => pending.promise);
  coordinator.edit({ entries: [{ id: 'fixed-entry', date: '2026-10-24', title: '散步', notes: '' }] });
  const saving = coordinator.save();
  assert.throws(() => coordinator.selection(['fixed-entry']), /保存/);
  pending.resolve(result({ kind: 'plan', saved: true, operationId: coordinator.state.pending.operationId, document: document(1, '行程', coordinator.state.draft.entries) })); await saving;
  assert.deepEqual(coordinator.selection(['fixed-entry']), { documentId: 'trip', revision: 1, entryIds: ['fixed-entry'], title: '行程', entries: [{ id: 'fixed-entry', date: '2026-10-24', title: '散步', notes: '' }] });
  coordinator.dispose();
});

test('tool errors are reported rather than rendered as successful content', () => {
  assert.throws(() => readToolValue({ isError: true, content: [{ type: 'text', text: '天气服务暂不可用' }] }), /天气服务暂不可用/);
  assert.throws(() => readToolValue({ content: [] }), /结果/);
});

test('rebasing a not-accepted draft discards its obsolete expected revision', async () => {
  const inputs = [];
  const coordinator = start(async (_key, input) => { inputs.push(input); if (inputs.length === 1) throw { data: { code: 'plugin_app_busy', notAccepted: true } }; return receipt(input); });
  coordinator.edit({ title: '待保存' }); await coordinator.save();
  coordinator.receive({ kind: 'plan', document: document(4, '远端更新') }); coordinator.merge(); await coordinator.save();
  assert.equal(inputs[1].expectedRevision, 4);
  assert.notEqual(inputs[0].operationId, inputs[1].operationId);
  assert.equal(coordinator.state.status, 'saved');
  coordinator.dispose();
});

test('reading the unchanged version during editing does not cancel automatic saving', async t => {
  const calls = [];
  const coordinator = createPlanCoordinator({ call: async (_key, input) => { calls.push(input); return receipt(input); }, delay: 5 });
  t.after(() => coordinator.dispose());
  coordinator.receive({ kind: 'plan', document: document() });
  coordinator.edit({ title: '等待自动保存' });
  coordinator.receive({ kind: 'plan', document: document() });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls.length, 1);
  assert.equal(coordinator.state.status, 'saved');
});

test('an older conflict reply cannot replace a newer document already delivered by the host', async t => {
  for (const checking of [false, true]) {
    const pending = deferred(); let original;
    const coordinator = start(async (key, input) => {
      if (key === 'SavePlanDraft') { original = input; if (checking) throw new Error('unknown outcome'); }
      return pending.promise;
    });
    t.after(() => coordinator.dispose());
    coordinator.edit({ title: '本地草稿' });
    let operation = coordinator.save();
    if (checking) { await operation; operation = coordinator.check(); }
    coordinator.receive({ kind: 'plan', document: document(3, '最新已知内容') });
    pending.resolve(result({ kind: 'plan', operationId: original.operationId, saved: false, conflict: true, document: document(2, '过时冲突快照'), draft: original }));
    await operation;
    assert.equal(coordinator.state.latest.revision, 3);
    assert.equal(coordinator.state.draft.title, '本地草稿');
  }
});

test('explicitly adopting the latest version clears the stored conflict draft after confirmation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'weather-adopt-draft-'));
  const service = createService({ dataDir: join(root, 'data'), workspaceRoot: root, sessionId: 'adopt-session' });
  const coordinator = createPlanCoordinator({ call: async (key, input) => result(await service.invoke(key, input)), delay: 60_000 });
  t.after(async () => { coordinator.dispose(); service.close(); await rm(root, { recursive: true, force: true }); });
  await service.invoke('SavePlanDraft', { documentId: 'trip', expectedRevision: 0, operationId: 'initial', title: '最新文档', entries: [] });
  await service.invoke('SavePlanDraft', { documentId: 'trip', expectedRevision: 0, operationId: 'conflict', title: '旧草稿', entries: [] });
  coordinator.receive(await service.invoke('ReadPlan', {}));
  coordinator.adopt(1);
  await coordinator.save();
  assert.equal(coordinator.state.status, 'saved');
  assert.equal((await service.invoke('ReadPlan', {})).draft, undefined);
  assert.equal((await service.invoke('ReadPlan', {})).document.title, '最新文档');
});

test('a tool error with an unknown side-effect outcome only queries the original receipt', async t => {
  const calls = [];
  const coordinator = start(async (key, input) => {
    calls.push([key, input]);
    if (key === 'GetOperation') return result({ kind: 'receipt', operationId: input.operationId, status: 'missing' });
    return { isError: true, structuredContent: { kind: 'error', code: 'operation_outcome_unknown' }, content: [{ type: 'text', text: 'Receipt storage unavailable after the write' }] };
  });
  t.after(() => coordinator.dispose());
  coordinator.edit({ title: '继续保留的草稿' }); await coordinator.save();
  assert.equal(coordinator.state.status, 'unknown');
  await coordinator.save(); await coordinator.check();
  assert.deepEqual(calls.map(([key]) => key), ['SavePlanDraft', 'GetOperation']);
  assert.equal(calls[0][1].operationId, calls[1][1].operationId);
});
