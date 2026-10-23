import { definitions } from './tools.mjs';

export const MAX_INPUT_BYTES = 64 * 1024 - 1;
export const MAX_DATA_BYTES = 256 * 1024;
export const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
export function bounded(value, bytes = MAX_DATA_BYTES) {
  let json;
  try { json = JSON.stringify(value); } catch { fail('invalid_input', 'Input must be JSON data'); }
  if (typeof json !== 'string') fail('invalid_input', 'Input must be JSON data');
  if (Buffer.byteLength(json) > bytes) fail(bytes === MAX_INPUT_BYTES ? 'input_too_large' : 'data_too_large', 'Data exceeds the allowed byte limit');
  return json;
}

function matches(value, schema) {
  if (schema.oneOf) return schema.oneOf.filter(option => matches(value, option)).length === 1;
  if ('const' in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
    if (schema.required.some(key => !Object.hasOwn(value, key))) return false;
    return Object.entries(value).every(([key, child]) => Object.hasOwn(schema.properties, key) && matches(child, schema.properties[key]));
  }
  if (schema.type === 'array') return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= schema.maxItems && value.every(child => matches(child, schema.items));
  if (schema.type === 'string') return typeof value === 'string' && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity) && (!schema.pattern || new RegExp(schema.pattern, 'u').test(value));
  if (schema.type === 'number' || schema.type === 'integer') return typeof value === 'number' && Number.isFinite(value) && (schema.type !== 'integer' || Number.isSafeInteger(value)) && value >= schema.minimum && value <= schema.maximum;
  if (schema.type === 'boolean') return typeof value === 'boolean';
  return true;
}

export function validatePlace(place) {
  try { new Intl.DateTimeFormat('en', { timeZone: place.timezone }); }
  catch { fail('invalid_input', 'Place must have a valid destination timezone'); }
}
function validateEntry(entry) {
  const date = new Date(entry.date + 'T00:00:00Z');
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== entry.date) fail('invalid_input', 'Entry date must be a real calendar date');
  if (entry.place) validatePlace(entry.place);
}
export function validateEntries(entries) {
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) fail('invalid_input', 'Entry IDs must be unique');
  for (const entry of entries) validateEntry(entry);
}
export function validateInput(key, input) {
  bounded(input, MAX_INPUT_BYTES);
  const definition = definitions.find(definition => definition.key === key);
  if (!definition) fail('unknown_tool', 'Unknown tool');
  if (!matches(input, definition.inputSchema)) fail('invalid_input', `Invalid ${key} arguments`);
  if (input.place) validatePlace(input.place);
  if (input.entries) validateEntries(input.entries);
  for (const operation of input.operations ?? []) if (operation.type === 'upsert') validateEntry(operation.entry);
}
export function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
