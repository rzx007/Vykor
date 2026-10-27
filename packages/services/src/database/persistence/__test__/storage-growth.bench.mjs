import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { SessionDatabase } from '../../session-database.ts';
import { SessionStore } from '../../../session-runtime/store.ts';
import { defaultDurableEventRegistry } from '../../../session-runtime/events/event-registry.ts';

// Run from packages/services with Node --expose-gc and the existing tsx loader.
// No user databases, models, product commands, dependencies or configuration.
const script = fileURLToPath(import.meta.url);
const sha256 = createHash('sha256').update(readFileSync(script)).digest('hex');
const tables = ['execution', 'tool_operation', 'tool_dispatch_attempt', 'session_message_part'];
const groups = [[100, 4096], [1000, 4096], [10000, 4096], [10000, 0]];
const stamp = 1_800_000_000_000;
const cwd = 'synthetic-storage-growth';
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
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

function worker(runs, bodyBytes) {
  assert.equal(typeof global.gc, 'function', 'Use --expose-gc');
  const directory = mkdtempSync(join(tmpdir(), 'vykor-storage-growth-'));
  const path = join(directory, 'synthetic.db');
  let store;
  const original = Database.prototype.prepare;
  let phase;
  const raw = {};
  function observe(name, rows) {
    const table = raw[phase][name];
    table.calls++;
    table.maxRows = Math.max(table.maxRows, rows.length);
  }
  function begin(name) { phase = name; raw[name] = Object.fromEntries(tables.map(table => [table, { calls: 0, maxRows: 0 }])); }
  try {
    seed(path, runs, bodyBytes);
    const databaseBytes = statSync(path).size;
    // Intercept the actual SQLite .all() result, before Drizzle maps or decodes it.
    // This is test-side only and does not retain the returned arrays.
    Database.prototype.prepare = function (query) {
      const statement = original.call(this, query);
      const name = tables.find(table => new RegExp(`\\bfrom\\s+"${table}"(?:\\s|$)`, 'i').test(query));
      if (name) {
        const all = statement.all;
        statement.all = function (...params) {
          const rows = all.apply(this, params);
          if (phase) observe(name, rows);
          return rows;
        };
      }
      return statement;
    };
    global.gc();
    const before = process.memoryUsage();
    begin('construct');
    let start = performance.now();
    store = new SessionStore({ path });
    const constructMs = performance.now() - start;
    phase = undefined;
    global.gc();
    const constructed = process.memoryUsage();
    begin('takeover');
    start = performance.now();
    store.acquireApplicationOwner({ ownerId: 'measurement-owner', pid: process.pid, staleAfterMs: 1000 });
    const takeoverMs = performance.now() - start;
    phase = undefined;
    const afterReloadWithoutGc = process.memoryUsage();
    global.gc();
    const reloaded = process.memoryUsage();
    function measure(query, expected) {
      for (let i = 0; i < 10; i++) assert.equal(query().length, expected);
      const samplesMs = [];
      for (let i = 0; i < 100; i++) {
        const begin = performance.now();
        const rows = query();
        samplesMs.push(performance.now() - begin);
        assert.equal(rows.length, expected);
      }
      return { samplesMs, medianMs: median(samplesMs) };
    }
    const candidates = measure(() => store.toolOperations.listResultCandidates('current'), 10);
    const safety = measure(() => store.toolOperations.listSafetyStates(), runs);
    for (const stats of Object.values(raw)) for (const table of tables) assert.ok(stats[table].calls > 0, `Missing raw observation: ${table}`);
    return { node: process.version, pid: process.pid, sha256, runs, bodyBytes, currentRuns: 10, databaseBytes, constructMs, takeoverMs, before, constructed, afterReloadWithoutGc, reloaded, raw, candidates, safety };
  } finally {
    Database.prototype.prepare = original;
    store?.close();
    const target = resolve(directory), child = relative(resolve(tmpdir()), target);
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child) && child.startsWith('vykor-storage-growth-'));
    rmSync(target, { recursive: true, force: true });
  }
}
function median(values) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; }
function aggregate(samples) {
  return groups.map(([runs, bodyBytes]) => {
    const rows = samples.filter(sample => sample.runs === runs && sample.bodyBytes === bodyBytes);
    return { runs, bodyBytes, samples: rows.length, databaseBytes: median(rows.map(row => row.databaseBytes)), constructedHeapDelta: median(rows.map(row => row.constructed.heapUsed - row.before.heapUsed)), constructedRssDelta: median(rows.map(row => row.constructed.rss - row.before.rss)), reloadHeapNoGcDelta: median(rows.map(row => row.afterReloadWithoutGc.heapUsed - row.before.heapUsed)), reloadRssNoGcDelta: median(rows.map(row => row.afterReloadWithoutGc.rss - row.before.rss)), reloadedHeapDelta: median(rows.map(row => row.reloaded.heapUsed - row.before.heapUsed)), reloadedRssDelta: median(rows.map(row => row.reloaded.rss - row.before.rss)), constructMs: median(rows.map(row => row.constructMs)), takeoverMs: median(rows.map(row => row.takeoverMs)), constructedHeap: median(rows.map(row => row.constructed.heapUsed)), constructedRss: median(rows.map(row => row.constructed.rss)), reloadHeapNoGc: median(rows.map(row => row.afterReloadWithoutGc.heapUsed)), reloadedHeap: median(rows.map(row => row.reloaded.heapUsed)), reloadedRss: median(rows.map(row => row.reloaded.rss)), candidatesMs: median(rows.map(row => row.candidates.medianMs)), safetyMs: median(rows.map(row => row.safety.medianMs)), raw: rows.map(row => row.raw) };
  });
}
if (process.argv[2] === '--worker') {
  console.log(JSON.stringify(worker(Number(process.argv[3]), Number(process.argv[4]))));
} else {
  const outputArg = process.argv.find(arg => arg.startsWith('--output='));
  const output = resolve(outputArg ? outputArg.slice('--output='.length) : join(tmpdir(), `storage-growth-${Date.now()}.json`));
  mkdirSync(dirname(output), { recursive: true });
  const samples = [];
  for (const [runs, bodyBytes] of groups) for (let sample = 1; sample <= 3; sample++) {
    console.error(`Starting independent worker: runs=${runs}, bytes=${bodyBytes}, sample=${sample}/3`);
    const child = spawnSync(process.execPath, [...process.execArgv, script, '--worker', String(runs), String(bodyBytes)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (child.status !== 0) throw new Error(`Worker failed (${child.status}): ${child.stderr}\n${child.stdout}`);
    const result = JSON.parse(child.stdout);
    assert.equal(result.sha256, sha256);
    assert.equal(result.node, process.version);
    samples.push(result);
    writeFileSync(`${output}.${runs}-${bodyBytes}-${sample}.worker.json`, `${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(output, `${JSON.stringify({ sha256, node: process.version, sequential: true, samples, medians: aggregate(samples) }, null, 2)}\n`);
    console.error(`Finished: construct=${result.constructMs.toFixed(1)}ms takeover=${result.takeoverMs.toFixed(1)}ms`);
  }
  console.log(JSON.stringify({ output, sha256, node: process.version, medians: aggregate(samples) }, null, 2));
}
