import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore } from '@vykor/services';
import { SessionDatabase } from '../../../../../../services/src/database/session-database.ts';
import { defaultDurableEventRegistry } from '../../../../../../services/src/session-runtime/events/event-registry.ts';
import { ToolOperationService } from '../tool-operation-service.ts';

// One process per invocation. The archived Python coordinator runs three fresh
// processes per version/round, sequentially, and retains every result.
const script = fileURLToPath(import.meta.url);
const root = realpathSync(resolve(dirname(script), '../../../../../../..'));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const sources = {
  server: fileURLToPath(new URL('../tool-operation-service.ts', import.meta.url)),
  services: fileURLToPath(import.meta.resolve('@vykor/services')),
  operations: join(root, 'packages/services/src/tool-operations/tool-operation-repository.ts'),
  executions: join(root, 'packages/services/src/execution-records/execution-repository.ts'),
};
for (const path of Object.values(sources)) {
  const child = relative(root, realpathSync(path));
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'Source escaped its checkout');
}
const stamp = 1_800_000_000_000;
const cwd = 'synthetic-storage-growth';
const uuid = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);
function seed(path, runs, bodyBytes) {
  const database = SessionDatabase.open({ path });
  const sql = database.connection;
  const prepared = new Map();
  function insert(table, row) {
    let statement = prepared.get(table);
    if (!statement) {
      const keys = Object.keys(row);
      statement = sql.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(key => `@${key}`).join(',')})`);
      prepared.set(table, statement);
    }
    statement.run(row);
  }
  try {
    sql.transaction(() => {
      for (const id of ['current', 'history']) insert('session', { id, cwd, title: id, model: 'synthetic', status: 'idle', metadata_json: '{}', created_at: stamp, updated_at: stamp });
      for (let i = 0; i < runs; i++) {
        const sessionId = i < 10 ? 'current' : 'history';
        const seq = i < 10 ? i + 1 : i - 9;
        const runId = `run-${i}`, inputId = `input-${i}`, executionId = `execution-${i}`;
        const operationId = `operation_${uuid(i + 1)}`, toolAttemptId = `tool_attempt_${uuid(i + 1)}`;
        const toolCallId = `call-${i}`;
        const body = bodyBytes ? (`run:${i}:` + 'x'.repeat(bodyBytes)).slice(0, bodyBytes) : '';
        const result = { toolUseId: toolCallId, toolName: 'Read', content: [{ type: 'text', text: body }], executionState: 'completed', operationId, toolAttemptId };
        const toolIdentity = JSON.stringify({ source: { kind: 'builtin' }, implementation: 'storage-growth-v1' });
        const intent = { sessionId, runId, agentId: 'agent', inputId, cwd, toolCallId, toolName: 'Read', input: {}, kind: 'read_only', toolIdentity };
        const operation = { id: operationId, operationId, sessionId, runId, executionId, agentId: 'agent', inputId, traceId: `trace-${i}`, cwd, toolCallId, toolName: 'Read', toolIdentity, normalizedInput: {}, kind: 'read_only', state: 'confirmed', revision: 4, intentRevision: 1, intentDigest: createHash('sha256').update(canonical(intent)).digest('hex'), policyVersion: 'synthetic', activeAttemptId: toolAttemptId, result, createdAt: stamp, updatedAt: stamp };
        const attempt = { id: toolAttemptId, operationId, toolAttemptId, revision: 3, ownerId: 'synthetic-owner', sessionId, runId, executionId, status: 'confirmed', startedAt: stamp, finishedAt: stamp, result };
        const execution = { id: executionId, sessionId, runId, status: 'completed', startedAt: stamp, finishedAt: stamp, createdAt: stamp, updatedAt: stamp };
        insert('session_input', { id: inputId, session_id: sessionId, seq, delivery: 'queue', content: 'read', items_json: JSON.stringify([{ type: 'text', text: 'read' }]), metadata_json: '{}', created_at: stamp });
        insert('session_run', { id: runId, session_id: sessionId, input_id: inputId, status: 'completed', started_at: stamp, finished_at: stamp, metadata_json: '{}', created_at: stamp, updated_at: stamp });
        insert('session_run_attempt', { id: `model-${i}`, run_id: runId, sequence: 1, status: 'completed', provider: 'synthetic', model: 'synthetic', started_at: stamp, finished_at: stamp, created_at: stamp, updated_at: stamp });
        for (let j = 0; j < 2; j++) {
          const messageId = `message-${i}-${j}`;
          insert('session_message', { id: messageId, session_id: sessionId, seq: seq * 2 - 1 + j, role: j ? 'assistant' : 'user', run_id: runId, input_id: inputId, metadata_json: '{}', created_at: stamp, updated_at: stamp });
          insert('session_message_part', { id: `part-${i}-${j}`, session_id: sessionId, message_id: messageId, seq: seq * 2 - 1 + j, type: j ? 'tool' : 'text', status: 'completed', text: j ? null : 'read', tool_use_id: j ? toolCallId : null, tool_name: j ? 'Read' : null, input_json: j ? '{}' : null, output_json: j ? JSON.stringify(result) : null, metadata_json: '{}', created_at: stamp, updated_at: stamp });
        }
        insert('execution', { id: executionId, session_id: sessionId, run_id: runId, data_json: JSON.stringify(execution) });
        insert('tool_operation', { id: operationId, session_id: sessionId, run_id: runId, logical_call_id: JSON.stringify([null, toolCallId]), state: 'confirmed', data_json: JSON.stringify(operation) });
        insert('tool_dispatch_attempt', { id: toolAttemptId, session_id: sessionId, operation_id: operationId, data_json: JSON.stringify(attempt) });
        const payload = { runId, generationId: `generation-${i}`, attempt: 1, model: 'synthetic' };
        defaultDurableEventRegistry.prepareRead('session.model.attempt.started', 1, payload, sessionId);
        insert('session_event', { id: `event-${i}`, seq: i + 1, type: 'session.model.attempt.started', schema_version: 1, session_id: sessionId, payload_json: JSON.stringify(payload), created_at: stamp });
      }
    })();
    assert.equal(sql.prepare("SELECT count(*) AS n FROM session_run WHERE session_id = 'current'").get().n, 10);
    for (const table of ['session_input', 'session_run', 'session_run_attempt', 'execution', 'tool_operation', 'tool_dispatch_attempt', 'session_event']) assert.equal(sql.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, runs);
    for (const table of ['session_message', 'session_message_part']) assert.equal(sql.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, runs * 2);
    assert.deepEqual(sql.pragma('foreign_key_check'), []);
  } finally { database.close(); }
}


const warmup = 10, repeats = 100, initialRuns = 10010, bodyBytes = 4096;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const stats = samplesMs => ({ samplesMs, medianMs: median(samplesMs),
  p95Ms: [...samplesMs].sort((a, b) => a - b)[Math.ceil(samplesMs.length * 0.95) - 1] });
async function measure(work) {
  for (let i = 0; i < warmup; i++) await work(i);
  const samples = [];
  for (let i = 0; i < repeats; i++) {
    const start = performance.now();
    await work(i + warmup);
    samples.push(performance.now() - start);
  }
  return stats(samples);
}
async function withStore(work) {
  const directory = mkdtempSync(join(tmpdir(), 'vykor-tool-hot-path-'));
  let store;
  try {
    const path = join(directory, 'synthetic.db');
    seed(path, initialRuns, bodyBytes);
    store = new SessionStore({ path });
    const lease = store.acquireApplicationOwner({ ownerId: 'measurement-owner', pid: process.pid, staleAfterMs: 600_000 });
    return await work(store, lease);
  } finally {
    store?.close();
    const child = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child) && child.startsWith('vykor-tool-hot-path-'));
    rmSync(directory, { recursive: true, force: true });
  }
}
function counts(store) {
  return { operations: store.toolOperations.listSafetyStates().length,
    currentCandidates: store.toolOperations.listResultCandidates('current').length,
    executions: store.executions.list().length,
    runs: Object.keys(store.storage.state.runs).length,
    attempts: Object.keys(store.storage.state.toolDispatchAttempts).length };
}
function intentFor(sessionId, runId, id, name = 'Write') {
  return { scope: { sessionId, agentId: sessionId, runId, inputId: 'bench-input',
    traceId: 'bench-trace', cwd, signal: new AbortController().signal },
    toolUse: { type: 'tool_use', id, name, input: { value: 1 } } };
}
function receiptResult(intent, executionState = 'completed') {
  return { toolUseId: intent.toolUse.id, toolName: intent.toolUse.name,
    content: [{ type: 'text', text: 'simulated receipt' }], executionState };
}
async function dispatchInput(service, intent) {
  let operation = await service.operations.prepare(intent);
  const policy = await service.requiredPolicy.check({ intent, operation, phase: 'authorization' });
  assert.equal(policy.allowed, true, policy.reason);
  operation = await service.operations.authorize({ intent, operation, policyVersion: policy.policyVersion });
  const recheck = await service.requiredPolicy.check({ intent, operation, phase: 'dispatch' });
  assert.equal(recheck.allowed, true, recheck.reason);
  return service.operations.dispatch({ intent, operation, policyVersion: recheck.policyVersion });
}
async function main() {
  assert.equal(typeof global.gc, 'function', 'Use --expose-gc');
  const candidates = await withStore(async store => {
    const initial = counts(store);
    assert.deepEqual(initial, { operations: initialRuns, currentCandidates: 10, executions: initialRuns,
      runs: initialRuns, attempts: initialRuns });
    const expectedIds = Array.from({ length: 10 }, (_, i) => `operation_${uuid(i + 1)}`);
    const timing = await measure(() => {
      const rows = store.toolOperations.listResultCandidates('current');
      assert.deepEqual(rows.map(row => row.operationId), expectedIds);
    });
    const final = counts(store);
    assert.deepEqual(final, initial);
    return { initial, final, timing };
  });
  const dispatch = await withStore(async (store, lease) => {
    store.runs.createRun({ id: 'bench-run', sessionId: 'current' });
    const service = new ToolOperationService({ store, ownerLease: () => lease });
    const initial = counts(store);
    const original = store.toolOperations.listSafetyStates;
    const safetyCalls = [];
    store.toolOperations.listSafetyStates = function (...args) {
      const start = performance.now();
      const rows = original.apply(this, args);
      safetyCalls.push({ ms: performance.now() - start, returned: rows.length });
      return rows;
    };
    try {
      const timing = await measure(async i => {
        const intent = intentFor('current', 'bench-run', `dispatch-${i}`);
        const receipt = await dispatchInput(service, intent);
        await service.operations.settle({ receipt, result: receiptResult(intent) });
        assert.equal(store.toolOperations.getSummary(receipt.operationId)?.state, 'confirmed');
      });
      assert.equal(safetyCalls.length, (warmup + repeats) * 4, 'All four safety reviews must execute');
      const measuredSafety = safetyCalls.splice(0);
      const final = counts(store);
      assert.deepEqual(final, { ...initial, operations: initialRuns + warmup + repeats,
        currentCandidates: 10 + warmup + repeats, executions: initialRuns + 1,
        attempts: initialRuns + warmup + repeats });
      return { initial, final, appendedOperations: warmup + repeats, timing,
        safety: { calls: measuredSafety, measured: stats(measuredSafety.slice(warmup * 4).map(row => row.ms)) } };
    } finally { store.toolOperations.listSafetyStates = original; }
  });
  // A separate fixture checks actual filtering for unknown/orphaned dispatches
  // and a read-only failed receipt. Unrelated roots still permit dispatch;
  // the read-only failure in the current tree must block it.
  const blocked = await withStore(async (store, lease) => {
    store.runs.createRun({ id: 'history-active', sessionId: 'history' });
    store.runs.createRun({ id: 'current-active', sessionId: 'current' });
    let failCommit = false;
    const service = new ToolOperationService({ store, ownerLease: () => lease,
      describe: intent => intent.toolUse.name === 'Read' ? { kind: 'read_only' } : undefined });
    const orphanIntent = intentFor('history', 'history-active', 'orphan');
    const orphan = await dispatchInput(service, orphanIntent);
    const unknownIntent = intentFor('history', 'history-active', 'unknown');
    const unknown = await dispatchInput(service, unknownIntent);
    await service.operations.settle({ receipt: unknown, result: receiptResult(unknownIntent, 'unknown') });
    store.runs.updateRun('history-active', { status: 'completed' });
    const intent = intentFor('current', 'current-active', 'blocked-write');
    const operation = await service.operations.prepare(intent);
    assert.equal((await service.requiredPolicy.check({ intent, operation, phase: 'authorization' })).allowed, true,
      'Unrelated roots must not block the current tree');
    const failedIntent = intentFor('current', 'current-active', 'failed-read', 'Read');
    const failed = await dispatchInput(service, failedIntent);
    const context = store.storage;
    context.coordinator.setHooks({ beforeCommit() { if (failCommit) throw new Error('synthetic receipt commit failure'); } });
    failCommit = true;
    await assert.rejects(service.operations.settle({ receipt: failed, result: receiptResult(failedIntent) }), /synthetic receipt commit failure/);
    failCommit = false;
    context.coordinator.setHooks();
    // Durable repair alone does not clear this Service's failed-receipt marker.
    // Its confirmed read-only ID must therefore survive the OR filter too.
    store.toolOperations.settle({ receipt: failed, result: receiptResult(failedIntent) });
    const original = store.toolOperations.listSafetyStates;
    const safetyCalls = [];
    store.toolOperations.listSafetyStates = function (...args) {
      const start = performance.now();
      const rows = original.apply(this, args);
      const ms = performance.now() - start;
      safetyCalls.push({ ms, returned: rows.length,
        pendingIncluded: [unknown.operationId, orphan.operationId, failed.operationId].every(id => rows.some(row => row.id === id)) });
      return rows;
    };
    try {
      const initial = counts(store);
      safetyCalls.length = 0;
      const timing = await measure(async () => {
        const policy = await service.requiredPolicy.check({ intent, operation, phase: 'authorization' });
        assert.equal(policy.allowed, false);
        assert.ok(policy.reason.includes(failed.operationId), 'Read-only failed receipt was lost');
      });
      const measured = safetyCalls.splice(0);
      const final = counts(store);
      assert.deepEqual(final, initial);
      assert.equal(measured.length, warmup + repeats);
      for (const call of measured) assert.ok(call.pendingIncluded, 'Pending or additional failure ID was omitted');
      await service.operations.settle({ receipt: failed, result: receiptResult(failedIntent), late: true });
      assert.equal((await service.requiredPolicy.check({ intent, operation, phase: 'dispatch' })).allowed, true);
      return { initial, final, timing, safety: measured,
        expectedPendingIds: [unknown.operationId, orphan.operationId, failed.operationId] };
    } finally { store.toolOperations.listSafetyStates = original; }
  });
  return { node: process.version, pid: process.pid, sha256: sha(script), root,
    sources: Object.fromEntries(Object.entries(sources).map(([name, path]) => [name, { path: realpathSync(path), sha256: sha(path) }])),
    seed: { totalRuns: initialRuns, unrelatedRuns: initialRuns - 10, currentResults: 10, bodyBytes, warmup, repeats },
    candidates, dispatch, blocked };
}
const result = await main();
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length);
if (output) writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
else console.log(JSON.stringify(result));
