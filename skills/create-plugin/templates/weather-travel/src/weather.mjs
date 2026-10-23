import { bounded, fail, MAX_DATA_BYTES, validateInput } from './validation.mjs';

const TTL = 10 * 60 * 1000, MAX_STALE = 24 * 60 * 60 * 1000;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const time = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(value) ? value : null;
function cachePut(cache, key, value, limit) { cache.delete(key); cache.set(key, value); while (cache.size > limit) cache.delete(cache.keys().next().value); }

async function requestJson(url, fetchImpl, signal) {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(8000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let reader;
  try {
    const response = await fetchImpl(url, { signal: combined, redirect: 'error', headers: { accept: 'application/json' } });
    combined.throwIfAborted();
    if (!response.ok) fail('weather_http_error', `Weather provider returned HTTP ${response.status}`);
    if (Number(response.headers.get('content-length')) > MAX_DATA_BYTES) fail('response_too_large', 'Weather response exceeds the byte limit');
    if (!response.body) fail('invalid_weather_data', 'Weather provider returned an empty response');
    reader = response.body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      const { value, done } = await reader.read(); combined.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DATA_BYTES) fail('response_too_large', 'Weather response exceeds the byte limit');
      chunks.push(Buffer.from(value));
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
    catch { fail('invalid_weather_data', 'Weather provider returned invalid JSON'); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) fail('invalid_weather_data', 'Weather provider returned unusable data');
    return data;
  } catch (error) {
    signal?.throwIfAborted();
    if (timeout.aborted) fail('network_timeout', 'Weather request timed out after 8 seconds');
    if (error.code && typeof error.code === 'string' && ['weather_http_error', 'response_too_large', 'invalid_weather_data'].includes(error.code)) throw error;
    fail('network_error', 'Could not reach the weather provider');
  } finally { if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); } }
}

function normalizeForecast(data, place, fetchedAt) {
  if (!data.current || !time(data.current.time) || !Array.isArray(data.daily?.time) || data.daily.time.length < 7 || !Array.isArray(data.hourly?.time)) fail('invalid_weather_data', 'Weather response is missing current, seven-day, or hourly data');
  const days = data.daily.time.slice(0, 7).map((date, index) => {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) fail('invalid_weather_data', 'Weather response contains an invalid date');
    return { date, min: number(data.daily.temperature_2m_min?.[index]), max: number(data.daily.temperature_2m_max?.[index]), rainProbability: number(data.daily.precipitation_probability_max?.[index]), weatherCode: number(data.daily.weather_code?.[index]) };
  });
  const hours = data.hourly.time.slice(0, 168).map((value, index) => {
    if (!time(value)) fail('invalid_weather_data', 'Weather response contains an invalid hour');
    return { time: value, temperature: number(data.hourly.temperature_2m?.[index]), rainProbability: number(data.hourly.precipitation_probability?.[index]), windSpeed: number(data.hourly.wind_speed_10m?.[index]) };
  });
  const result = { kind: 'forecast', place, timezone: place.timezone, fetchedAt: new Date(fetchedAt).toISOString(), expiresAt: new Date(fetchedAt + TTL).toISOString(), stale: false,
    source: { name: 'Open-Meteo', url: 'https://open-meteo.com/' },
    current: { time: data.current.time, temperature: number(data.current.temperature_2m), weatherCode: number(data.current.weather_code), windSpeed: number(data.current.wind_speed_10m) }, days, hours };
  bounded(result); return result;
}

export function createWeather({ fetchImpl, now }) {
  const forecasts = new Map(), searches = new Map();
  return {
    async search(query, signal) {
      query = query.trim(); if (!query) fail('invalid_input', 'Search query cannot be empty');
      signal?.throwIfAborted();
      const cached = searches.get(query);
      if (cached && cached.until > now()) return structuredClone(cached.data);
      const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
      url.search = new URLSearchParams({ name: query, count: '10', language: 'en', format: 'json' }).toString();
      const data = await requestJson(url, fetchImpl, signal);
      if (data.results !== undefined && !Array.isArray(data.results)) fail('invalid_weather_data', 'City search returned unusable data');
      const places = (data.results ?? []).slice(0, 10).flatMap(row => {
        if (!row || typeof row !== 'object' || (!Number.isSafeInteger(row.id) && typeof row.id !== 'string')) return [];
        const place = { id: String(row.id), name: row.name, country: typeof row.country === 'string' ? row.country.slice(0, 100) : '', latitude: row.latitude, longitude: row.longitude, timezone: row.timezone };
        try { validateInput('GetForecast', { place }); } catch { return []; }
        return [place];
      });
      const result = { kind: 'places', places }; bounded(result);
      cachePut(searches, query, { until: now() + MAX_STALE, data: result }, 64);
      return structuredClone(result);
    },
    async forecast(place, force, signal) {
      signal?.throwIfAborted();
      const key = JSON.stringify([place.latitude, place.longitude, place.timezone]);
      let cached = forecasts.get(key);
      const clock = now();
      if (cached && clock - cached.at > MAX_STALE) { forecasts.delete(key); cached = undefined; }
      if (!force && cached && clock - cached.at < TTL) return structuredClone({ ...cached.data, place });
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.search = new URLSearchParams({ latitude: String(place.latitude), longitude: String(place.longitude), timezone: place.timezone, forecast_days: '7', temperature_unit: 'celsius', wind_speed_unit: 'kmh',
        current: 'temperature_2m,weather_code,wind_speed_10m', daily: 'temperature_2m_min,temperature_2m_max,precipitation_probability_max,weather_code', hourly: 'temperature_2m,precipitation_probability,wind_speed_10m' }).toString();
      try {
        const data = normalizeForecast(await requestJson(url, fetchImpl, signal), place, now());
        cachePut(forecasts, key, { at: now(), data }, 32);
        return structuredClone(data);
      } catch (error) {
        signal?.throwIfAborted();
        if (!cached) throw error;
        return structuredClone({ ...cached.data, place, stale: true, refreshError: { code: error.code ?? 'network_error', message: error.message } });
      }
    },
    close() { forecasts.clear(); searches.clear(); },
  };
}
