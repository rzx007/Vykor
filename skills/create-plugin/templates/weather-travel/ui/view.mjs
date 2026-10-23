import { createPlanCoordinator, isNotAccepted, readToolValue } from './coordinator.mjs';

const conditions = new Map([[0, '晴'], [1, '大部晴朗'], [2, '多云'], [3, '阴'], [45, '雾'], [48, '雾凇'], [51, '小毛毛雨'], [53, '毛毛雨'], [55, '强毛毛雨'], [56, '冻毛毛雨'], [57, '强冻毛毛雨'], [61, '小雨'], [63, '雨'], [65, '大雨'], [66, '冻雨'], [67, '强冻雨'], [71, '小雪'], [73, '雪'], [75, '大雪'], [77, '雪粒'], [80, '小阵雨'], [81, '阵雨'], [82, '强阵雨'], [85, '阵雪'], [86, '强阵雪'], [95, '雷雨'], [96, '雷雨伴冰雹'], [99, '强雷雨伴冰雹']]);
const weather = code => conditions.get(code) || '天气资料缺失';
const number = (value, unit = '') => Number.isFinite(value) ? `${Math.round(value * 10) / 10}${unit}` : '—';
const placeName = place => [place.name, place.country].filter(Boolean).join(' · ');
const clone = value => structuredClone(value);
const validPlace = place => place && typeof place.id === 'string' && typeof place.name === 'string' && Number.isFinite(place.latitude) && Number.isFinite(place.longitude);
const samePlace = (first, second) => first?.id === second?.id;
const describe = value => `${value.title}\n${value.entries.map(entry => `${entry.date} · ${entry.title}${entry.place ? ` · ${placeName(entry.place)}` : ''}\n${entry.notes}`).join('\n\n')}`;

export function createPanel({ app, document, names, config, applyStyle = () => {} }) {
  const el = id => document.getElementById(id);
  const win = document.defaultView;
  const selected = new Set(), entryRows = new Map(), comparisons = new Map(), knownPlaces = new Map();
  let context = {}, hostHidden = false, admissionPaused = false, refreshing = false, refreshNeeded = false, querySequence = 0, forecastSequence = 0;
  let currentForecast, selectedDate, favorites = { revision: 0, places: [] }, favoriteOperation, exportOperation, adoptionRevision;
  let favoriteBusy = false, exporting = false, connected = false, disposed = false;
  const visible = () => !document.hidden && !hostHidden;
  const report = message => { el('status').textContent = message; };
  const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
  const button = (text, action) => { const element = node('button', text); element.type = 'button'; element.addEventListener('click', () => { void action(); }); return element; };
  function resumeExplicitly() { if (visible()) { admissionPaused = false; coordinator.setVisible(true); } }
  const bind = (id, action) => el(id).addEventListener('click', () => { if (!el(id).disabled) { resumeExplicitly(); void action(); } });
  function suspendOnHidden(error) {
    if (isNotAccepted(error) && error.data.code === 'plugin_app_hidden') { admissionPaused = true; coordinator.setVisible(false); }
  }
  async function call(key, input) {
    if (!visible()) throw { data: { code: 'plugin_app_hidden', notAccepted: true }, message: '页面已隐藏，请回到页面后继续。' };
    try { return await app.callServerTool({ name: names[key], arguments: input }); }
    catch (error) { suspendOnHidden(error); throw error; }
  }
  const coordinator = createPlanCoordinator({ call, onChange: renderPlan });
  function controls() {
    const state = coordinator.state, saved = state.status === 'saved', available = connected && visible();
    el('search').disabled = !available;
    el('plan-title').disabled = !state.document;
    el('add-entry').disabled = !state.document || state.draft.entries.length >= 120;
    el('add-weather-entry').disabled = !state.document || state.draft.entries.length >= 120;
    el('save').disabled = !available || !state.document || !['dirty', 'error'].includes(state.status);
    el('check-save').hidden = !state.unknown;
    el('check-save').disabled = !available;
    el('selection').hidden = !app.getHostCapabilities()?.updateModelContext;
    el('weather-selection').hidden = el('selection').hidden;
    el('weather-selection').disabled = !available || !currentForecast?.days.some(day => day.date === selectedDate);
    el('selection-help').hidden = el('selection').hidden;
    el('selection').disabled = !available || !saved || !selected.size;
    el('export').disabled = !available || !saved || exporting || !!exportOperation || !el('export-path').value.trim();
    el('check-export').hidden = !exportOperation;
    el('check-export').disabled = !available || exporting;
    el('favorite-toggle').disabled = !available || !currentForecast || favoriteBusy || !!favoriteOperation;
    el('favorite-toggle').textContent = favorites.places.some(place => samePlace(place, currentForecast?.place)) ? '取消收藏' : '收藏城市';
    el('compare-add').disabled = !available || !currentForecast || comparisons.has(currentForecast.place.id) || comparisons.size >= 3;
    el('refresh-plan').disabled = !available || refreshing;
    el('refresh-weather').disabled = !available;
    el('fullscreen').hidden = !context.availableDisplayModes?.includes('fullscreen');
    const cannotResolve = !!state.pending || !!state.unknown;
    for (const id of ['merge', 'adopt', 'confirm-adopt']) el(id).disabled = cannotResolve;
  }
  function renderPlan() {
    const state = coordinator.state;
    const labels = { loading: '正在读取…', saved: '已确认保存', dirty: '有修改 · 稍后自动保存', saving: '正在保存…', unknown: '保存结果待核实', conflict: '新版有变化 · 草稿已保留', error: '保存失败 · 草稿已保留' };
    el('save-state').textContent = labels[state.status];
    el('revision').textContent = state.document ? `版本 ${state.document.revision}` : '';
    el('plan-error').textContent = state.error;
    if (state.draft && el('plan-title').value !== state.draft.title) el('plan-title').value = state.draft.title;
    el('conflict').hidden = !state.conflict;
    if (state.conflict && state.latest) {
      el('remote-version').textContent = `查看新版 · 版本 ${state.latest.revision}`;
      el('remote').textContent = describe(state.latest);
      el('recovered-section').hidden = !state.recoveredDraft;
      el('recovered').textContent = state.recoveredDraft ? describe(state.recoveredDraft) : '';
      if (adoptionRevision !== state.latest.revision) { adoptionRevision = undefined; el('adopt-confirmation').hidden = true; }
    }
    const ids = new Set(state.draft?.entries.map(entry => entry.id) || []);
    for (const [id, row] of entryRows) if (!ids.has(id)) { row.remove(); entryRows.delete(id); selected.delete(id); }
    for (const entry of state.draft?.entries || []) {
      let row = entryRows.get(entry.id);
      if (!row) {
        row = createEntryRow(entry.id); entryRows.set(entry.id, row); el('entries').append(row);
      }
      for (const field of ['date', 'title', 'notes']) { const input = row.querySelector(`[data-field="${field}"]`); if (input.value !== entry[field]) input.value = entry[field]; }
      row.querySelector('[data-entry-select]').checked = selected.has(entry.id);
      renderPlaceOptions(row.querySelector('[data-field="place"]'), entry.place);
    }
    el('entries-empty').hidden = ids.size > 0;
    controls();
  }
  function createEntryRow(id) {
    const row = node('article', undefined, 'entry'); row.dataset.entryId = id;
    const heading = node('div', undefined, 'entry-heading');
    const label = node('label', undefined, 'check-label'), check = node('input'); check.type = 'checkbox'; check.dataset.entrySelect = id;
    check.addEventListener('change', () => { if (check.checked) selected.add(id); else selected.delete(id); controls(); });
    label.append(check, document.createTextNode('引用此条目')); heading.append(label, button('删除条目', () => { coordinator.edit({ entries: coordinator.state.draft.entries.filter(entry => entry.id !== id) }); })); row.append(heading);
    const fields = node('div', undefined, 'entry-fields');
    for (const [field, text, tag, type] of [['date','出行日期','input','date'], ['title','安排','input','text'], ['place','地点','select'], ['notes','备注','textarea']]) {
      const fieldLabel = node('label', text), input = node(tag); input.dataset.field = field; input.id = `${field}-${id}`; fieldLabel.htmlFor = input.id;
      if (type) input.type = type;
      if (field === 'notes') { input.rows = 2; input.maxLength = 4000; fieldLabel.className = 'wide'; }
      if (field === 'title') input.maxLength = 160;
      input.addEventListener(field === 'place' ? 'change' : 'input', () => {
        const entries = coordinator.state.draft.entries.map(entry => {
          if (entry.id !== id) return entry;
          const updated = { ...entry };
          if (field === 'place') { if (input.value) updated.place = clone(knownPlaces.get(input.value)); else delete updated.place; }
          else updated[field] = input.value;
          return updated;
        }); coordinator.edit({ entries });
      });
      fieldLabel.append(input); fields.append(fieldLabel);
    }
    row.append(fields); return row;
  }
  function renderPlaceOptions(select, place) {
    if (place) knownPlaces.set(place.id, place);
    const signature = [...knownPlaces.keys()].join('\0');
    if (select.dataset.options !== signature) {
      select.replaceChildren(); const empty = node('option', '不指定地点'); empty.value = ''; select.append(empty);
      for (const item of knownPlaces.values()) { const option = node('option', placeName(item)); option.value = item.id; select.append(option); }
      select.dataset.options = signature;
    }
    select.value = place?.id || '';
  }
  function addEntry(place, date) {
    if (!coordinator.state.draft || coordinator.state.draft.entries.length >= 120) return;
    const today = new Date(), localDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const entry = { id: crypto.randomUUID(), date: date || localDate, title: '', notes: '', ...(place ? { place: clone(place) } : {}) };
    coordinator.edit({ entries: [...coordinator.state.draft.entries, entry] });
    entryRows.get(entry.id)?.querySelector('[data-field="title"]').focus();
  }
  async function refresh() {
    if (!visible() || admissionPaused || refreshing || disposed) { refreshNeeded = true; return; }
    refreshing = true; refreshNeeded = false; controls();
    try {
      const plan = readToolValue(await call('ReadPlan', {})); coordinator.receive(plan);
      if (visible()) { const value = readToolValue(await call('ReadFavorites', {})); if (value.kind === 'favorites') renderFavorites(value); }
    } catch (error) { refreshNeeded = true; report(error.message || '读取未完成，请回到页面后点击“读取新版”。'); }
    finally { refreshing = false; controls(); }
  }
  function renderFavorites(value) {
    if (!Number.isSafeInteger(value.revision) || !Array.isArray(value.places) || value.places.some(place => !validPlace(place))) throw new Error('收藏结果无效。');
    if (value.revision < favorites.revision) return;
    favorites = clone(value); el('favorites').replaceChildren(); el('favorites-empty').hidden = !!favorites.places.length;
    for (const place of favorites.places) {
      knownPlaces.set(place.id, place);
      const row = node('li'); row.append(button(placeName(place), () => loadForecast(place))); el('favorites').append(row);
    }
    renderPlan();
  }
  async function search(event) {
    event?.preventDefault(); if (!visible()) return; resumeExplicitly();
    const query = el('city-query').value.trim(); if (!query) return;
    const sequence = ++querySequence; el('search-status').textContent = '正在搜索城市…';
    try {
      const value = readToolValue(await call('SearchPlaces', { query }));
      if (sequence !== querySequence) return;
      if (value.kind !== 'places' || !Array.isArray(value.places) || value.places.some(place => !validPlace(place))) throw new Error('城市搜索结果无效。');
      el('places').replaceChildren();
      for (const place of value.places) {
        knownPlaces.set(place.id, place);
        const row = node('li'), use = button(placeName(place), () => loadForecast(place)), compare = button('比较', () => comparePlace(place));
        compare.dataset.comparePlace = place.id; compare.setAttribute('aria-label', `比较${placeName(place)}`);
        row.append(use, compare); el('places').append(row);
      }
      el('search-status').textContent = value.places.length ? `找到 ${value.places.length} 个地点，请按国家和城市选择。` : '没有找到城市。请换用完整名称或当地名称。';
      renderPlan();
    } catch (error) { el('search-status').textContent = error.message || '搜索失败，请稍后重试。'; }
  }
  async function fetchForecast(place, force) {
    const value = readToolValue(await call('GetForecast', { place, ...(force ? { force: true } : {}) }));
    if (value.kind !== 'forecast' || !validPlace(value.place) || !Array.isArray(value.days) || !Array.isArray(value.hours) || !value.current) throw new Error('天气结果无效，请刷新。');
    return value;
  }
  async function loadForecast(place, force = false) {
    if (!visible()) return;
    const sequence = ++forecastSequence; report(`正在读取${place.name}天气…`);
    try {
      const value = await fetchForecast(place, force); if (sequence !== forecastSequence) return;
      currentForecast = value; knownPlaces.set(value.place.id, value.place);
      if (!value.days.some(day => day.date === selectedDate)) selectedDate = value.days[0]?.date;
      renderForecast(); report('');
    } catch (error) { report(error.message || '读取天气失败。'); }
  }
  function renderForecast() {
    const value = currentForecast; if (!value) return;
    el('forecast').hidden = false; el('forecast-place').textContent = placeName(value.place);
    el('current').textContent = `${number(value.current.temperature, ' °C')} · ${weather(value.current.weatherCode)} · 风速 ${number(value.current.windSpeed, ' km/h')}`;
    el('weather-meta').textContent = `${value.current.time || '观测时间缺失'} · ${value.timezone} · ${value.stale ? '缓存已过期，请刷新' : '更新于 ' + value.fetchedAt}`;
    const source = el('weather-source'); source.textContent = value.source?.name || 'Open-Meteo';
    const sourceURL = value.source?.url; if (typeof sourceURL === 'string' && /^https:\/\/(?:[\w-]+\.)?open-meteo\.com(?:\/|$)/.test(sourceURL)) source.href = sourceURL; else source.removeAttribute('href');
    el('days').replaceChildren();
    for (const day of value.days) {
      const item = button('', () => { selectedDate = day.date; renderForecast(); }); item.className = 'day'; item.setAttribute('aria-pressed', String(day.date === selectedDate));
      item.append(node('span', day.date.slice(5)), node('span', weather(day.weatherCode), 'muted'), node('strong', `${number(day.min)}–${number(day.max)} °C`), node('span', `雨 ${number(day.rainProbability, '%')}`, 'muted'));
      el('days').append(item);
    }
    const hours = value.hours.filter(hour => hour.time.startsWith(selectedDate));
    el('hourly-caption').textContent = `${selectedDate || ''} · 逐小时气温预报（${value.timezone}）`;
    renderChart(hours); el('hours').replaceChildren();
    for (const hour of hours) { const row = node('tr'); for (const text of [hour.time.slice(11), number(hour.temperature), number(hour.rainProbability), number(hour.windSpeed)]) row.append(node('td', text)); el('hours').append(row); }
    renderComparison(); controls();
  }
  function renderChart(hours) {
    const target = el('hourly-chart'); target.replaceChildren();
    const series = hours.filter(hour => Number.isFinite(hour.temperature));
    if (series.length < 2) { target.append(node('p', '该日期的逐小时气温不足，请查看七日预报或刷新天气。', 'muted')); return; }
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 560 160'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', '逐小时气温预报，单位摄氏度；详细数值见下方表格');
    const temperatures = series.map(hour => hour.temperature), low = Math.floor((Math.min(...temperatures) - 1) / 5) * 5, high = Math.ceil((Math.max(...temperatures) + 1) / 5) * 5;
    const time = hour => Date.parse(`${hour.time}Z`), first = time(series[0]), last = time(series.at(-1));
    const x = hour => 48 + (time(hour) - first) / Math.max(1, last - first) * 496, y = temperature => 125 - (temperature - low) / (high - low) * 110;
    const svgNode = (tag, attrs, text) => { const item = document.createElementNS(ns, tag); for (const [key,value] of Object.entries(attrs)) item.setAttribute(key, value); if (text !== undefined) item.textContent = text; svg.append(item); return item; };
    for (let step = 0; step <= 2; step++) { const temperature = low + (high - low) * step / 2, yy = y(temperature); svgNode('line', { x1: 48, x2: 544, y1: yy, y2: yy, class: 'chart-grid' }); svgNode('text', { x: 40, y: yy + 4, 'text-anchor': 'end', class: 'chart-label' }, `${number(temperature)} °C`); }
    const indexes = [...new Set([0, Math.floor((series.length - 1) / 3), Math.floor((series.length - 1) * 2 / 3), series.length - 1])];
    for (const index of indexes) svgNode('text', { x: x(series[index]), y: 149, 'text-anchor': index === 0 ? 'start' : index === series.length - 1 ? 'end' : 'middle', class: 'chart-label' }, series[index].time.slice(11,16));
    svgNode('polyline', { points: series.map(hour => `${x(hour)},${y(hour.temperature)}`).join(' '), class: 'forecast-line' }); target.append(svg);
  }
  async function comparePlace(place) {
    if (!visible() || comparisons.has(place.id)) return;
    if (comparisons.size >= 3) { report('最多比较 3 个城市。请先移除一个城市。'); return; }
    const marker = { place }; comparisons.set(place.id, marker); renderComparison(); controls();
    try { const value = await fetchForecast(place); if (comparisons.get(place.id) === marker) comparisons.set(place.id, value); }
    catch (error) { if (comparisons.get(place.id) === marker) comparisons.set(place.id, { place, error: error.message || '读取失败' }); }
    renderComparison(); controls();
  }
  function renderComparison() {
    el('comparison-section').hidden = !comparisons.size; el('comparison').replaceChildren();
    for (const [id, value] of comparisons) {
      const row = node('div', undefined, 'comparison-row'), text = node('div'); text.append(node('strong', placeName(value.place)));
      const day = value.days?.find(day => day.date === selectedDate) || value.days?.[0];
      text.append(node('p', value.error || (day ? `${day.date} · ${number(day.min)}–${number(day.max)} °C · 雨 ${number(day.rainProbability,'%')} · ${weather(day.weatherCode)}` : '正在读取预报…'), 'muted'));
      row.append(text, button('移除', () => { comparisons.delete(id); renderComparison(); controls(); })); el('comparison').append(row);
    }
  }
  async function toggleFavorite() {
    if (!currentForecast || favoriteBusy || favoriteOperation || !visible()) return;
    const input = { expectedRevision: favorites.revision, operationId: crypto.randomUUID(), place: clone(currentForecast.place), enabled: !favorites.places.some(place => samePlace(place, currentForecast.place)) };
    favoriteBusy = true; controls();
    try {
      const value = readToolValue(await call('SetFavorite', input));
      if (value.saved === true && value.operationId === input.operationId && value.revision === input.expectedRevision + 1) { renderFavorites(value); report('收藏已确认更新。'); }
      else if (value.conflict === true) { renderFavorites(value); report('收藏已有更新，已读取新版，请重试。'); }
      else { favoriteOperation = input; report('收藏结果待核实，请核实原收藏。'); }
    } catch (error) { if (isNotAccepted(error) || error.toolFailure) report(error.message || '收藏未送出，请稍后重试。'); else { favoriteOperation = input; report('收藏结果待核实，请核实原收藏。'); } }
    finally { favoriteBusy = false; renderFavoriteCheck(); controls(); }
  }
  function renderFavoriteCheck() {
    let check = el('check-favorite');
    if (favoriteOperation && !check) { check = button('核实原收藏', () => { resumeExplicitly(); return checkFavorite(); }); check.id = 'check-favorite'; el('favorites-section').append(check); }
    if (favoriteOperation) el('favorites-section').open = true;
    if (check) check.hidden = !favoriteOperation;
  }
  async function checkFavorite() {
    if (!favoriteOperation || !visible() || favoriteBusy) return;
    const input = favoriteOperation; favoriteBusy = true;
    try {
      const value = readToolValue(await call('GetOperation', { operationId: input.operationId }));
      if (value.saved === true && value.operationId === input.operationId && value.kind === 'favorites' && value.revision === input.expectedRevision + 1) { renderFavorites(value); favoriteOperation = undefined; report('原收藏操作已确认。'); }
      else if (value.operationId === input.operationId && value.kind === 'favorites' && value.saved === false && value.conflict === true) { renderFavorites(value); favoriteOperation = undefined; report('原收藏操作未保存：收藏版本已有变化。请检查后重试。'); }
      else report('原收藏仍未确认，没有重发。');
    } catch (error) { report(error.message || '无法核实原收藏。'); }
    finally { favoriteBusy = false; renderFavoriteCheck(); controls(); }
  }
  function confirmedExport(value, input) { return value.kind === 'export' && value.saved === true && value.operationId === input.operationId && value.revision === input.expectedRevision && typeof value.path === 'string'; }
  async function exportPlan(check = false) {
    if (!visible() || exporting) return;
    if (!check && (exportOperation || coordinator.state.status !== 'saved')) return;
    const input = check ? exportOperation : { documentId: coordinator.state.document.id, expectedRevision: coordinator.state.document.revision, operationId: crypto.randomUUID(), path: el('export-path').value.trim(), format: el('export-format').value, overwrite: el('overwrite').checked };
    if (!input || !input.path) return;
    const extension = input.format === 'json' ? '.json' : '.md';
    if (!input.path.toLowerCase().endsWith(extension)) { el('export-status').textContent = `请使用 ${extension} 文件路径。`; return; }
    exporting = true; el('export-status').textContent = check ? '正在核实原导出…' : '正在请求导出确认…'; controls();
    try {
      const value = readToolValue(await call(check ? 'GetOperation' : 'ExportPlan', check ? { operationId: input.operationId } : input));
      if (confirmedExport(value, input)) { exportOperation = undefined; el('export-status').textContent = `已保存：${value.path} · 版本 ${value.revision}`; }
      else if (value.saved === false && value.conflict === true) { exportOperation = undefined; coordinator.receive(value); el('export-status').textContent = '行程版本已有变化，本次未导出。请检查新版并重新选择导出。'; }
      else { exportOperation = input; el('export-status').textContent = '导出结果待核实。请核实原导出，不会重发。'; }
    } catch (error) {
      if (!check && (isNotAccepted(error) || error.toolFailure)) el('export-status').textContent = error.message || '导出未完成，请检查路径后重试。';
      else { exportOperation = input; el('export-status').textContent = '导出结果待核实。请核实原导出，不会重发。'; }
    } finally { exporting = false; controls(); }
  }
  function hostContext(update) {
    context = { ...context, ...update };
    if (update.styles?.variables) applyStyle(update.styles.variables);
    if (update.theme) document.documentElement.dataset.theme = update.theme;
    if ('visibility' in update) hostHidden = update.visibility === 'hidden';
    else if ('visible' in update) hostHidden = update.visible === false;
    else if ('isVisible' in update) hostHidden = update.isVisible === false;
    if (('visibility' in update || 'visible' in update || 'isVisible' in update) && !hostHidden) admissionPaused = false;
    coordinator.setVisible(visible() && !admissionPaused); controls();
    if (visible() && !admissionPaused && refreshNeeded) void refresh();
  }
  function visibilityChanged() { if (visible()) admissionPaused = false; coordinator.setVisible(visible()); controls(); if (visible() && refreshNeeded) void refresh(); }
  function receive(value) {
    try {
      const data = readToolValue(value);
      if (data.kind === 'plan') coordinator.receive(data);
      if (data.kind === 'favorites' && !favoriteBusy && !favoriteOperation) renderFavorites(data);
      if (data.kind === 'forecast') { currentForecast = data; selectedDate = data.days?.[0]?.date; renderForecast(); }
    } catch (error) { report(error.message); }
  }
  el('app-name').textContent = config.displayName;
  el('search-form').addEventListener('submit', search);
  el('plan-title').addEventListener('input', () => coordinator.edit({ title: el('plan-title').value }));
  el('export-path').addEventListener('input', controls);
  bind('refresh-plan', refresh); bind('save', () => coordinator.save()); bind('check-save', () => coordinator.check());
  bind('add-entry', () => addEntry()); bind('add-weather-entry', () => addEntry(currentForecast.place, selectedDate));
  bind('refresh-weather', () => loadForecast(currentForecast.place, true)); bind('favorite-toggle', toggleFavorite); bind('compare-add', () => comparePlace(currentForecast.place));
  bind('merge', () => coordinator.merge());
  bind('adopt', () => { adoptionRevision = coordinator.state.latest?.revision; el('adopt-confirmation').hidden = false; });
  bind('cancel-adopt', () => { adoptionRevision = undefined; el('adopt-confirmation').hidden = true; });
  bind('confirm-adopt', () => { coordinator.adopt(adoptionRevision); el('adopt-confirmation').hidden = true; });
  bind('selection', async () => { try { const selection = coordinator.selection([...selected]); if (new TextEncoder().encode(JSON.stringify(selection)).byteLength > 32 * 1024) throw new Error('所选条目超过 32 KiB，请减少选择。'); await app.updateModelContext({ content: [{ type: 'text', text: `出行“${selection.title}”：引用 ${selection.entryIds.length} 条已保存条目，版本 ${selection.revision}。` }], structuredContent: selection }); report('已引用到聊天，请在聊天中填写要求并发送。'); } catch (error) { report(error.message); } });
  bind('weather-selection', async () => {
    if (!app.getHostCapabilities()?.updateModelContext || !currentForecast) return;
    const day = currentForecast.days.find(day => day.date === selectedDate); if (!day) return;
    const { place, timezone, fetchedAt, source, stale } = currentForecast;
    const selection = { kind: 'forecast-selection', placeId: place.id, place: clone(place), latitude: place.latitude, longitude: place.longitude, timezone, date: selectedDate, day: clone(day), hours: clone(currentForecast.hours.filter(hour => hour.time.startsWith(selectedDate))), fetchedAt, source: clone(source), stale };
    try { await app.updateModelContext({ content: [{ type: 'text', text: `${placeName(place)} ${selectedDate} 预报：${number(day.min)}–${number(day.max)} °C，降水概率 ${number(day.rainProbability, '%')}。${stale ? '缓存已过期，请刷新后使用。' : ''}` }], structuredContent: selection }); report('当天预报已引用到聊天，请填写要求并发送。'); }
    catch (error) { report(error.message || '无法引用预报，请稍后重试。'); }
  });
  bind('export', () => exportPlan()); bind('check-export', () => exportPlan(true));
  bind('fullscreen', async () => { if (!context.availableDisplayModes?.includes('fullscreen')) return; try { await app.requestDisplayMode({ mode: 'fullscreen' }); } catch (error) { report(error.message || '宿主未能进入全屏。'); } });
  document.addEventListener('visibilitychange', visibilityChanged);
  const beforeUnload = event => { if (coordinator.state.document && coordinator.state.status !== 'saved') { event.preventDefault(); event.returnValue = ''; } };
  win?.addEventListener('beforeunload', beforeUnload);
  return { coordinator, comparisons, hostContext, receive, refresh,
    async start() { connected = true; hostContext(app.getHostContext() || {}); await refresh(); },
    resourceChanged() { refreshNeeded = true; if (visible() && !admissionPaused) void refresh(); },
    dispose() { disposed = true; coordinator.dispose(); document.removeEventListener('visibilitychange', visibilityChanged); win?.removeEventListener('beforeunload', beforeUnload); },
  };
}
