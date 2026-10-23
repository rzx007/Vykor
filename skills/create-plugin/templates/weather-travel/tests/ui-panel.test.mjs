import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createPanel } from '../ui/view.mjs';

const template = await readFile(new URL('../ui/panel.template.html', import.meta.url), 'utf8');
const city = (id, name) => ({ id, name, country: 'CN', latitude: 31, longitude: 121, timezone: 'Asia/Shanghai' });
const shanghai = city('shanghai', '上海'), springfield = city('springfield', '同名城市');
const forecast = place => ({ kind: 'forecast', place, timezone: place.timezone, fetchedAt: '2026-10-23T01:00:00Z', expiresAt: '2026-10-23T01:15:00Z', stale: false, source: { name: 'Open-Meteo', url: 'https://open-meteo.com/' }, current: { time: '2026-10-23T09:00', temperature: 21, weatherCode: 1, windSpeed: 7 }, days: [23,24,25,26,27,28,29].map((day, i) => ({ date: `2026-10-${day}`, min: 14 + i, max: 22 + i, rainProbability: i * 10, weatherCode: 1 })), hours: [23,24].flatMap(day => [0,6,12,18].map((hour, i) => ({ time: `2026-10-${day}T${String(hour).padStart(2,'0')}:00`, temperature: 14 + i * 2, rainProbability: i * 10, windSpeed: 7 }))) });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function setup(override = {}) {
  const dom = new JSDOM(template, { url: 'https://plugin.invalid/', pretendToBeVisual: true });
  const calls = [], contexts = [];
  const app = {
    getHostCapabilities: () => ({ updateModelContext: {}, availableDisplayModes: ['fullscreen'] }),
    getHostContext: () => ({}),
    async callServerTool({ name, arguments: input }) {
      const key = name.replace(/^test_/, ''); calls.push([key, input]);
      if (override[key]) return { structuredContent: await override[key](input) };
      if (key === 'GetForecast') return { structuredContent: forecast(input.place) };
      const data = { ReadPlan: { kind: 'plan', document: { id: 'trip', revision: 0, title: '出行', entries: [] } }, ReadFavorites: { kind: 'favorites', revision: 0, places: [] }, SearchPlaces: { kind: 'places', places: [shanghai, springfield] } };
      if (key === 'SavePlanDraft') return { structuredContent: { kind: 'plan', operationId: input.operationId, saved: true, document: { id: 'trip', revision: input.expectedRevision + 1, title: input.title, entries: input.entries } } };
      return { structuredContent: data[key] };
    },
    async updateModelContext(value) { contexts.push(value); },
    async requestDisplayMode(value) { return value; },
  };
  const names = Object.fromEntries(['ReadPlan','ReadFavorites','SearchPlaces','GetForecast','SavePlanDraft','GetOperation','SetFavorite','ExportPlan'].map(key => [key, `test_${key}`]));
  const panel = createPanel({ app, document: dom.window.document, names, config: { displayName: '天气行程', name: 'test', version: '1.0.0' }, applyStyle: () => {} });
  await panel.start();
  return { dom, document: dom.window.document, app, panel, calls, contexts, close() { panel.dispose(); dom.window.close(); } };
}
async function search(environment) { environment.document.querySelector('#city-query').value = '同名'; environment.document.querySelector('#search-form').dispatchEvent(new environment.dom.window.Event('submit', { bubbles: true, cancelable: true })); await tick(); }

test('search requires explicit place selection and renders actual seven day and hourly values', async () => {
  const env = await setup();
  assert.equal(env.document.querySelector('#forecast').hidden, true);
  await search(env);
  assert.equal(env.calls.filter(([key]) => key === 'GetForecast').length, 0);
  assert.equal(env.document.querySelectorAll('#places li').length, 2);
  env.document.querySelector('#places button').click(); await tick();
  assert.equal(env.document.querySelectorAll('#days button').length, 7);
  assert.match(env.document.querySelector('#current').textContent, /21 °C/);
  assert.match(env.document.querySelector('#hourly-chart').textContent, /°C/);
  env.document.querySelectorAll('#days button')[1].click();
  assert.match(env.document.querySelector('#hourly-caption').textContent, /2026-10-24/);
  assert.equal(env.document.querySelectorAll('#hours tr').length, 4);
  env.close();
});

test('entry edits keep stable ids and host theme notifications preserve form inputs', async () => {
  const env = await setup();
  env.document.querySelector('#add-entry').click();
  const title = env.document.querySelector('[data-field="title"]');
  const id = env.panel.coordinator.state.draft.entries[0].id;
  title.value = '<img src=x onerror=alert(1)>'; title.dispatchEvent(new env.dom.window.Event('input', { bubbles: true }));
  env.panel.hostContext({ theme: 'dark', styles: { variables: { '--color-background-primary': '#111' } } });
  assert.equal(env.document.querySelector('[data-field="title"]'), title);
  assert.equal(title.value, '<img src=x onerror=alert(1)>');
  assert.equal(env.panel.coordinator.state.draft.entries[0].id, id);
  await env.panel.coordinator.save();
  env.document.querySelector('[data-entry-select]').click();
  env.document.querySelector('#selection').click(); await tick();
  assert.deepEqual(env.contexts[0].structuredContent.entryIds, [id]);
  assert.equal(env.contexts[0].structuredContent.revision, 1);
  assert.equal(env.document.querySelectorAll('img').length, 0);
  env.close();
});

test('host hidden context prevents new reads, searches, saves, and export checks', async () => {
  const env = await setup();
  env.panel.hostContext({ visibility: 'hidden' });
  const before = env.calls.length;
  await search(env); await env.panel.refresh();
  env.document.querySelector('#refresh-plan').click(); await tick();
  assert.equal(env.calls.length, before);
  env.close();
});

test('an export with an unknown side effect keeps its original id and never offers a new export', async () => {
  const env = await setup({ GetOperation: input => ({ kind: 'receipt', operationId: input.operationId, status: 'missing' }) });
  const original = env.app.callServerTool.bind(env.app);
  env.app.callServerTool = async request => {
    if (request.name !== 'test_ExportPlan') return original(request);
    env.calls.push(['ExportPlan', request.arguments]);
    return { isError: true, structuredContent: { kind: 'error', code: 'operation_outcome_unknown' }, content: [{ type: 'text', text: 'Receipt could not be confirmed after export' }] };
  };
  try {
    env.document.querySelector('#export-path').value = 'trip.md';
    env.document.querySelector('#export-path').dispatchEvent(new env.dom.window.Event('input'));
    env.document.querySelector('#export').click(); await tick();
    assert.match(env.document.querySelector('#export-status').textContent, /结果待核实/);
    assert.equal(env.document.querySelector('#export').disabled, true);
    env.document.querySelector('#export').click();
    env.document.querySelector('#check-export').click(); await tick();
    assert.equal(env.calls.filter(([key]) => key === 'ExportPlan').length, 1);
    assert.equal(env.calls.find(([key]) => key === 'GetOperation')[1].operationId, env.calls.find(([key]) => key === 'ExportPlan')[1].operationId);
  } finally { env.close(); }
});

test('export shows actual receipt and an unknown export only checks its original operation', async () => {
  let exportInput;
  const env = await setup({ ExportPlan(input) { exportInput = input; throw new Error('timeout'); }, GetOperation(input) { return { kind: 'export', operationId: input.operationId, saved: true, path: 'trips/actual.md', revision: 0 }; } });
  env.document.querySelector('#export-path').value = 'trips/requested.md';
  env.document.querySelector('#export-path').dispatchEvent(new env.dom.window.Event('input'));
  env.document.querySelector('#export').click(); await tick();
  assert.match(env.document.querySelector('#export-status').textContent, /待核实/);
  env.document.querySelector('#export').click(); await tick();
  assert.equal(env.calls.filter(([key]) => key === 'ExportPlan').length, 1);
  env.document.querySelector('#check-export').click(); await tick();
  assert.equal(env.calls.at(-1)[1].operationId, exportInput.operationId);
  assert.match(env.document.querySelector('#export-status').textContent, /trips\/actual.md/);
  env.close();
});

test('comparison caps at three cities and favorite receipts persist actual server revision', async () => {
  let revision = 0;
  const env = await setup({ SearchPlaces() { return { kind: 'places', places: [shanghai, springfield, city('third','第三城'), city('fourth','第四城')] }; }, SetFavorite(input) { return { kind: 'favorites', revision: ++revision, places: input.enabled ? [input.place] : [], operationId: input.operationId, saved: true }; } });
  await search(env);
  for (const button of [...env.document.querySelectorAll('[data-compare-place]')]) { button.click(); await tick(); }
  assert.equal(env.panel.comparisons.size, 3);
  assert.equal(env.calls.filter(([key]) => key === 'GetForecast').length, 3);
  env.document.querySelector('#places button').click(); await tick();
  env.document.querySelector('#favorite-toggle').click(); await tick();
  assert.match(env.document.querySelector('#favorites').textContent, /上海/);
  env.close();
});

test('a hidden admission rejection stops automatic calls and an explicit visible action resumes', async () => {
  let attempt = 0;
  const env = await setup({ SavePlanDraft(input) { if (++attempt === 1) throw { data: { code: 'plugin_app_hidden', notAccepted: true } }; return { kind: 'plan', saved: true, operationId: input.operationId, document: { id: 'trip', revision: input.expectedRevision + 1, title: input.title, entries: input.entries } }; } });
  env.document.querySelector('#plan-title').value = '新安排'; env.document.querySelector('#plan-title').dispatchEvent(new env.dom.window.Event('input'));
  await env.panel.coordinator.save();
  env.panel.resourceChanged(); await tick();
  assert.equal(env.calls.filter(([key]) => key === 'SavePlanDraft').length, 1);
  assert.equal(env.calls.filter(([key]) => key === 'ReadPlan').length, 1);
  env.document.querySelector('#save').click(); await tick();
  assert.equal(env.panel.coordinator.state.status, 'saved');
  assert.equal(env.calls.filter(([key]) => key === 'SavePlanDraft').length, 2);
  env.close();
});

test('changing selected date updates every comparison to the same date', async () => {
  const env = await setup(); await search(env);
  env.document.querySelector('#places button').click(); await tick();
  env.document.querySelector('[data-compare-place]').click(); await tick();
  env.document.querySelectorAll('#days button')[1].click();
  assert.match(env.document.querySelector('#comparison').textContent, /2026-10-24/);
  env.close();
});

test('an explicit export conflict shows the latest revision without claiming an unknown export', async () => {
  const env = await setup({ ExportPlan(input) { return { kind: 'plan', operationId: input.operationId, saved: false, conflict: true, document: { id: 'trip', revision: 2, title: '新版出行', entries: [] } }; } });
  env.document.querySelector('#export-path').value = 'trips/plan.md'; env.document.querySelector('#export-path').dispatchEvent(new env.dom.window.Event('input'));
  env.document.querySelector('#export').click(); await tick();
  assert.equal(env.document.querySelector('#check-export').hidden, true);
  assert.match(env.document.querySelector('#export-status').textContent, /未导出/);
  assert.equal(env.panel.coordinator.state.document.revision, 2);
  env.close();
});

test('favorite conflict adopts the returned revision before a user retries', async () => {
  let attempt = 0;
  const env = await setup({ SetFavorite(input) { if (++attempt === 1) return { kind: 'favorites', revision: 4, places: [], operationId: input.operationId, saved: false, conflict: true }; return { kind: 'favorites', revision: 5, places: [input.place], operationId: input.operationId, saved: true }; } });
  await search(env); env.document.querySelector('#places button').click(); await tick();
  env.document.querySelector('#favorite-toggle').click(); await tick();
  assert.match(env.document.querySelector('#status').textContent, /已有更新/);
  env.document.querySelector('#favorite-toggle').click(); await tick();
  assert.equal(env.calls.filter(([key]) => key === 'SetFavorite')[1][1].expectedRevision, 4);
  assert.match(env.document.querySelector('#favorites').textContent, /上海/);
  env.close();
});

test('checking an old successful favorite receipt preserves a newer favorite read', async () => {
  let reads = 0;
  const env = await setup({ ReadFavorites() { return { kind: 'favorites', revision: reads++ ? 4 : 0, places: reads > 1 ? [springfield] : [] }; }, SetFavorite() { throw new Error('timeout'); }, GetOperation(input) { return { kind: 'favorites', revision: 1, places: [shanghai], operationId: input.operationId, saved: true }; } });
  await search(env); env.document.querySelector('#places button').click(); await tick();
  env.document.querySelector('#favorite-toggle').click(); await tick();
  await env.panel.refresh(); env.document.querySelector('#check-favorite').click(); await tick();
  assert.match(env.document.querySelector('#favorites').textContent, /同名城市/);
  assert.doesNotMatch(env.document.querySelector('#favorites').textContent, /上海/);
  env.close();
});

test('forecast context references the selected day with actual source and place without changing the trip', async () => {
  const env = await setup(); await search(env); env.document.querySelector('#places button').click(); await tick();
  env.document.querySelectorAll('#days button')[1].click();
  env.document.querySelector('#weather-selection').click(); await tick();
  const selection = env.contexts[0].structuredContent;
  assert.equal(selection.placeId, 'shanghai');
  assert.equal(selection.latitude, 31); assert.equal(selection.longitude, 121);
  assert.equal(selection.timezone, 'Asia/Shanghai'); assert.equal(selection.date, '2026-10-24');
  assert.deepEqual(selection.day, { date: '2026-10-24', min: 15, max: 23, rainProbability: 10, weatherCode: 1 });
  assert.equal(selection.fetchedAt, '2026-10-23T01:00:00Z'); assert.equal(selection.stale, false);
  assert.equal(selection.source.url, 'https://open-meteo.com/');
  assert.equal(selection.hours.length, 4);
  assert.equal(env.calls.filter(([key]) => key === 'SavePlanDraft').length, 0);
  assert.deepEqual(env.panel.coordinator.state.draft.entries, []);
  env.app.getHostCapabilities = () => ({}); env.panel.hostContext({ theme: 'light' });
  assert.equal(env.document.querySelector('#weather-selection').hidden, true);
  env.close();
});
