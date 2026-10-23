// Save coordination is independent of the host transport and the DOM.
const clone = value => structuredClone(value);
const contents = value => JSON.stringify({ title: value.title, entries: value.entries });
const editable = value => ({ title: value.title, entries: clone(value.entries) });
export function isNotAccepted(error) {
  return error?.data?.notAccepted === true && ['plugin_app_busy', 'plugin_app_hidden'].includes(error.data.code);
}
export function readToolValue(result) {
  if (result?.isError) {
    const error = new Error(result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || '操作失败，输入已保留。');
    error.toolFailure = result.structuredContent?.code !== 'operation_outcome_unknown';
    throw error;
  }
  if (!result?.structuredContent || typeof result.structuredContent !== 'object') throw new Error('工具未返回可确认的结果。');
  return result.structuredContent;
}
export function validDocument(value) {
  return value?.id === 'trip' && Number.isSafeInteger(value.revision) && value.revision >= 0 && typeof value.title === 'string'
    && Array.isArray(value.entries) && value.entries.every(entry => typeof entry.id === 'string' && typeof entry.date === 'string' && typeof entry.title === 'string' && typeof entry.notes === 'string');
}
export function createPlanCoordinator({ call, onChange = () => {}, delay = 650, makeId = () => crypto.randomUUID() }) {
  const state = { document: undefined, draft: undefined, latest: undefined, recoveredDraft: undefined, pending: undefined, unknown: undefined, status: 'loading', error: '', visible: true, conflict: false };
  let timer, safeRetry, failed = false, checking = false, disposed = false, clearRecoveredDraft = false;
  const dirty = () => !!state.document && (clearRecoveredDraft || contents(state.draft) !== contents(state.document));
  function rememberLatest(document) {
    if (!state.latest || document.revision >= state.latest.revision) state.latest = clone(document);
  }
  function publish() {
    state.status = state.pending ? 'saving' : state.unknown ? 'unknown' : state.conflict ? 'conflict' : !state.document ? 'loading' : failed ? 'error' : dirty() ? 'dirty' : 'saved';
    onChange(state);
  }
  function cancel() { clearTimeout(timer); timer = undefined; }
  function schedule() {
    cancel();
    if (disposed || !state.visible || !dirty() || state.pending || state.unknown || state.conflict || failed) return;
    timer = setTimeout(() => { timer = undefined; void save(); }, delay);
    timer.unref?.();
  }
  function receive(value) {
    if (value?.kind !== 'plan' || !validDocument(value.document)) return;
    const remote = clone(value.document);
    if (state.latest && remote.revision < state.latest.revision) return;
    state.latest = remote;
    if (value.draft) state.recoveredDraft = clone(value.draft);
    if (!state.document) {
      state.document = remote;
      state.draft = value.draft && typeof value.draft.title === 'string' && Array.isArray(value.draft.entries) ? editable(value.draft) : editable(remote);
      state.conflict = !!value.draft;
    } else if (dirty() || state.pending || state.unknown || state.conflict) {
      if (remote.revision > state.document.revision) state.conflict = true;
    } else {
      state.document = remote; state.draft = editable(remote);
      if (value.draft) state.conflict = true;
    }
    publish(); schedule();
  }
  function edit(patch) {
    if (!state.draft) return;
    state.draft = { ...state.draft, ...clone(patch) };
    state.error = ''; failed = false;
    // A not-accepted snapshot has never reached the tool; keep its id only while its input matches.
    if (safeRetry && contents(safeRetry) !== contents(state.draft)) safeRetry = undefined;
    publish(); schedule();
  }
  function confirmed(value, operation) {
    return value?.kind === 'plan' && value.saved === true && value.operationId === operation.operationId
      && validDocument(value.document) && value.document.revision === operation.expectedRevision + 1
      && contents(value.document) === contents(operation);
  }
  function accept(value, operation) {
    state.document = clone(value.document);
    rememberLatest(value.document);
    state.unknown = undefined; safeRetry = undefined; failed = false; clearRecoveredDraft = false; state.error = '';
    state.conflict = state.latest.revision > state.document.revision;
    if (!state.conflict) state.recoveredDraft = undefined;
  }
  function unknown(operation) {
    state.unknown = operation;
    state.error = '保存结果待核实。草稿已保留，请点击“核实原保存”；不会重发。';
  }
  async function save() {
    cancel();
    if (!state.visible || !state.document || state.pending || state.unknown || state.conflict || !dirty()) return;
    const operation = safeRetry || { documentId: state.document.id, expectedRevision: state.document.revision, operationId: makeId(), ...editable(state.draft) };
    state.pending = operation; state.error = ''; failed = false; publish();
    try {
      const value = readToolValue(await call('SavePlanDraft', operation));
      if (confirmed(value, operation)) accept(value, operation);
      else if (value.saved === false && value.conflict === true && validDocument(value.document)) {
        rememberLatest(value.document); state.recoveredDraft = clone(value.draft || operation); state.conflict = true;
        state.error = '保存时发现新版。当前输入已保留，请对照后手工合并。';
      } else unknown(operation);
    } catch (error) {
      if (isNotAccepted(error)) { safeRetry = contents(operation) === contents(state.draft) ? operation : undefined; state.error = '页面忙碌或已隐藏，输入尚未送出；可见时继续保存。'; }
      else if (error.toolFailure) { failed = true; state.error = error.message; }
      else unknown(operation);
    } finally { state.pending = undefined; publish(); schedule(); }
  }
  async function check() {
    if (!state.visible || !state.unknown || state.pending || checking) return;
    const operation = state.unknown; checking = true;
    try {
      const value = readToolValue(await call('GetOperation', { operationId: operation.operationId }));
      if (confirmed(value, operation)) accept(value, operation);
      else if (value.conflict === true && value.operationId === operation.operationId && validDocument(value.document)) {
        state.unknown = undefined; rememberLatest(value.document); state.recoveredDraft = clone(value.draft || operation); state.conflict = true;
      } else state.error = '仍未找到成功回执。当前输入已保留，原操作没有重发。';
    } catch (error) { state.error = `无法核实原保存：${error.message || '页面暂不可用'}。草稿仍保留。`; }
    finally { checking = false; publish(); schedule(); }
  }
  function merge() {
    if (!state.latest || state.pending || state.unknown) return;
    clearRecoveredDraft = !!state.recoveredDraft;
    state.document = clone(state.latest); state.conflict = false; state.recoveredDraft = undefined; failed = false; safeRetry = undefined;
    state.error = '已保留编辑区内容，并采用新版作为保存起点。请检查后点击保存。';
    publish();
  }
  function adopt(revision) {
    if (!state.latest || state.latest.revision !== revision || state.pending || state.unknown) return;
    // Clear a persisted conflict draft through the same checked save, even when contents match.
    clearRecoveredDraft = !!state.recoveredDraft;
    state.document = clone(state.latest); state.draft = editable(state.latest); state.conflict = false; state.recoveredDraft = undefined; failed = false; safeRetry = undefined;
    state.error = ''; publish(); schedule();
  }
  function selection(ids) {
    if (!state.document || state.status !== 'saved') throw new Error('请先合并并确认保存，再引用条目。');
    const entries = state.document.entries.filter(entry => ids.includes(entry.id));
    if (!entries.length) throw new Error('请先选择要引用的出行条目。');
    return { documentId: state.document.id, revision: state.document.revision, entryIds: entries.map(entry => entry.id), title: state.document.title, entries: clone(entries) };
  }
  return { state, receive, edit, save, check, merge, adopt, selection,
    setVisible(visible) { state.visible = visible; cancel(); if (visible) schedule(); },
    dispose() { disposed = true; cancel(); },
  };
}
