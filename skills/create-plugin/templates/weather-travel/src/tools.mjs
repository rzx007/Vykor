const text = maxLength => ({ type: 'string', maxLength });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const identifier = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.:-]+$' };
const revision = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
export const placeSchema = object({
  id: { ...text(128), minLength: 1 }, name: { ...text(160), minLength: 1 }, country: text(100),
  latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 },
  timezone: { ...text(100), minLength: 1 },
});
const entry = object({ id: identifier, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, title: text(160), notes: text(4000), place: placeSchema }, ['id', 'date', 'title', 'notes']);
const entries = { type: 'array', maxItems: 120, items: entry };
const write = { documentId: { const: 'trip' }, expectedRevision: revision, operationId: identifier };
const both = ['model', 'app'];
export const definitions = [
  { key: 'SearchPlaces', description: 'Search real cities using Open-Meteo. Choose the returned coordinates and destination timezone.', group: 'network', visibility: both, inputSchema: object({ query: { ...text(120), minLength: 1 } }) },
  { key: 'GetForecast', description: 'Get current, seven-day, and hourly weather for a place. Units are °C, km/h, and percent. Stale data is explicitly marked.', group: 'network', visibility: both, inputSchema: object({ place: placeSchema, force: { type: 'boolean' } }, ['place']) },
  { key: 'ReadPlan', description: 'Read this session’s trip, its revision, and any received conflicting draft. Read before modifying fixed entry IDs.', group: 'data', visibility: both, inputSchema: object({}) },
  { key: 'ApplyPlanOperations', description: 'Modify a previously read trip using fixed entry IDs and its expected revision. An operation ID identifies one exact request.', group: 'data', visibility: both, inputSchema: object({ ...write, operations: { type: 'array', minItems: 1, maxItems: 120, items: { oneOf: [object({ type: { const: 'upsert' }, entry }), object({ type: { const: 'remove' }, id: identifier })] } }, title: text(160) }, [...Object.keys(write), 'operations']) },
  { key: 'SavePlanDraft', description: 'Save the app editor’s bounded trip draft with a revision check; retain received conflict drafts for recovery. Never retry an unknown operation blindly.', group: 'data', visibility: ['app'], inputSchema: object({ ...write, title: text(160), entries }) },
  { key: 'ReadFavorites', description: 'Read shared favorite places and their current revision.', group: 'data', visibility: both, inputSchema: object({}) },
  { key: 'SetFavorite', description: 'Add or remove an app-selected favorite with a revision check and exact operation ID.', group: 'data', visibility: ['app'], inputSchema: object({ expectedRevision: revision, operationId: identifier, place: placeSchema, enabled: { type: 'boolean' } }) },
  { key: 'ExportPlan', description: 'Export the checked trip revision as Markdown or JSON within the bound workspace. Existing files require explicit overwrite:true and ordinary host confirmation. After an unknown outcome, query GetOperation.', group: 'export', visibility: both, inputSchema: object({ ...write, path: { ...text(300), minLength: 1 }, format: { enum: ['markdown', 'json'] }, overwrite: { type: 'boolean', default: false } }, [...Object.keys(write), 'path', 'format']) },
  { key: 'GetOperation', description: 'Get the exact original receipt for an operation ID, or missing. Does not replay the operation.', group: 'data', visibility: both, inputSchema: object({ operationId: identifier }) },
];

export function toolResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], metadata: { appData: data } };
}

export function toolError(error) {
  const data = { kind: 'error', code: typeof error?.code === 'string' ? error.code : 'internal_error', message: error instanceof Error ? error.message : 'The request failed' };
  return { ...toolResult(data), isError: true };
}
