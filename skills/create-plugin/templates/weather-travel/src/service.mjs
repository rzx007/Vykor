import { isAbsolute } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { createStore } from './store.mjs';
import { validateInput, validateEntries, bounded, fail } from './validation.mjs';
import { exportDocument } from './export.mjs';
import { createWeather } from './weather.mjs';

export function createService({ dataDir, sessionId, sessionKey, workspaceRoot, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot)) fail('host_binding_missing', 'The host must bind an absolute workspace directory');
  let workspace;
  try { workspace = realpathSync(workspaceRoot); if (!statSync(workspace).isDirectory()) throw new Error(); }
  catch { fail('host_binding_missing', 'The bound workspace directory must exist'); }
  const store = createStore(dataDir, sessionId, sessionKey);
  const weather = createWeather({ fetchImpl, now });
  let closed = false;
  const readPlan = () => ({ kind: 'plan', ...store.plan() });
  const readFavorites = () => ({ kind: 'favorites', ...store.favorites() });
  const conflict = (input, state) => ({ kind: 'plan', operationId: input.operationId, saved: false, conflict: true, document: state.document });
  return {
    readPlan, readFavorites,
    async invoke(key, input = {}, signal) {
      if (closed) fail('service_closed', 'Service is closed');
      validateInput(key, input); signal?.throwIfAborted();
      if (key === 'ReadPlan') return readPlan();
      if (key === 'ReadFavorites') return readFavorites();
      if (key === 'GetOperation') return store.receipt(input.operationId) ?? { kind: 'receipt', operationId: input.operationId, status: 'missing' };
      if (key === 'SearchPlaces') return weather.search(input.query, signal);
      if (key === 'GetForecast') return weather.forecast(input.place, input.force, signal);
      return store.transact(key, input, () => {
        signal?.throwIfAborted();
        if (key === 'SetFavorite') {
          const state = store.favorites();
          if (state.revision !== input.expectedRevision) return { kind: 'favorites', ...state, operationId: input.operationId, saved: false, conflict: true };
          const places = state.places.filter(place => place.id !== input.place.id);
          if (input.enabled) places.push(input.place);
          if (places.length > 100) fail('favorites_limit', 'At most 100 favorite places can be saved');
          const updated = { revision: state.revision + 1, places }; store.putFavorites(updated);
          return { kind: 'favorites', ...updated, operationId: input.operationId, saved: true };
        }
        const state = store.plan();
        if (state.document.revision !== input.expectedRevision) {
          if (key === 'SavePlanDraft') { store.putPlan({ ...state, draft: input }); return { ...conflict(input, state), draft: input }; }
          return conflict(input, state);
        }
        if (key === 'ExportPlan') return exportDocument(state.document, input, workspace);
        let entries = input.entries;
        if (key === 'ApplyPlanOperations') {
          const byId = new Map(state.document.entries.map(entry => [entry.id, entry]));
          for (const operation of input.operations) {
            if (operation.type === 'remove') byId.delete(operation.id); else byId.set(operation.entry.id, operation.entry);
          }
          entries = [...byId.values()];
          if (entries.length > 120) fail('entries_limit', 'At most 120 trip entries can be saved');
          validateEntries(entries);
        }
        const document = { id: 'trip', revision: state.document.revision + 1, title: input.title ?? state.document.title, entries };
        bounded(document); store.putPlan({ document, ...(key !== 'SavePlanDraft' && state.draft ? { draft: state.draft } : {}) });
        return { kind: 'plan', document, operationId: input.operationId, saved: true };
      });
    },
    close() { if (!closed) { closed = true; weather.close(); store.close(); } },
  };
}
