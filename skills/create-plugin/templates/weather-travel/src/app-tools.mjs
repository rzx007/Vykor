// @ts-check
import { definePluginAppTool } from '../ui/app-client.mjs';

/** @typedef {{ id: string, name: string, country: string, latitude: number, longitude: number, timezone: string }} Place */
/** @typedef {{ id: string, date: string, title: string, notes: string, place?: Place }} Entry */
/** @typedef {{ id: 'trip', revision: number, title: string, entries: Entry[] }} Trip */
/** @typedef {{ documentId: 'trip', expectedRevision: number, operationId: string, title: string, entries: Entry[] }} SavePlan */
/** @typedef {{ kind: 'plan', document: Trip, draft?: SavePlan, operationId?: string, saved?: boolean, conflict?: boolean, duplicate?: boolean }} PlanResult */
/** @typedef {{ kind: 'favorites', revision: number, places: Place[], operationId?: string, saved?: boolean, conflict?: boolean, duplicate?: boolean }} FavoritesResult */
/** @typedef {{ kind: 'export', operationId: string, saved: true, path: string, revision: number, duplicate?: boolean }} ExportResult */
/** @typedef {{ kind: 'error', code: string, message: string }} Failure */
/** @typedef {{ kind: 'receipt', operationId: string, status: 'missing' }} MissingReceipt */
/** @typedef {{ kind: 'forecast', place: Place, timezone: string, fetchedAt: string, expiresAt: string, stale: boolean, source: { name: string, url: string }, current: { time: string, temperature: number | null, weatherCode: number | null, windSpeed: number | null }, days: Array<{ date: string, min: number | null, max: number | null, rainProbability: number | null, weatherCode: number | null }>, hours: Array<{ time: string, temperature: number | null, rainProbability: number | null, windSpeed: number | null }>, refreshError?: { code: string, message: string } }} Forecast */

/** @typedef {'SearchPlaces' | 'GetForecast' | 'ReadPlan' | 'SavePlanDraft' | 'ReadFavorites' | 'SetFavorite' | 'ExportPlan' | 'GetOperation'} AppToolKey */
/** @param {Record<AppToolKey, string>} names */
export function createWeatherTools(names) {
  return {
    /** @type {import('../ui/app-client.mjs').PluginAppTool<{ query: string }, { kind: 'places', places: Place[] } | Failure>} */
    SearchPlaces: definePluginAppTool(names.SearchPlaces),
    /** @type {import('../ui/app-client.mjs').PluginAppTool<{ place: Place, force?: boolean }, Forecast | Failure>} */
    GetForecast: definePluginAppTool(names.GetForecast),
    /** @type {import('../ui/app-client.mjs').PluginAppTool<Record<string, never>, PlanResult | Failure>} */
    ReadPlan: definePluginAppTool(names.ReadPlan),
    /** @type {import('../ui/app-client.mjs').PluginAppTool<SavePlan, PlanResult | Failure>} */
    SavePlanDraft: definePluginAppTool(names.SavePlanDraft),
    /** @type {import('../ui/app-client.mjs').PluginAppTool<Record<string, never>, FavoritesResult | Failure>} */
    ReadFavorites: definePluginAppTool(names.ReadFavorites),
    /** @type {import('../ui/app-client.mjs').PluginAppTool<{ expectedRevision: number, operationId: string, place: Place, enabled: boolean }, FavoritesResult | Failure>} */
    SetFavorite: definePluginAppTool(names.SetFavorite),
    /** @type {import('../ui/app-client.mjs').PluginAppTool<{ documentId: 'trip', expectedRevision: number, operationId: string, path: string, format: 'markdown' | 'json', overwrite?: boolean }, ExportResult | PlanResult | Failure>} */
    ExportPlan: definePluginAppTool(names.ExportPlan),
    /** @type {import('../ui/app-client.mjs').PluginAppTool<{ operationId: string }, PlanResult | FavoritesResult | ExportResult | MissingReceipt | Failure>} */
    GetOperation: definePluginAppTool(names.GetOperation),
  };
}
