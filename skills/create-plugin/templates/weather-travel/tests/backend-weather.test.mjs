import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/service.mjs';

const place = { id: '1816670', name: 'Beijing', country: 'China', latitude: 39.9, longitude: 116.4, timezone: 'Asia/Shanghai' };
const forecast = {
  latitude: 39.875, longitude: 116.375, generationtime_ms: 0.1, utc_offset_seconds: 28800, timezone: 'Asia/Shanghai', timezone_abbreviation: 'GMT+8', elevation: 51,
  current_units: { time: 'iso8601', interval: 'seconds', temperature_2m: '°C', weather_code: 'wmo code', wind_speed_10m: 'km/h' },
  current: { time: '2026-10-23T12:00', interval: 900, temperature_2m: 0, weather_code: 0, wind_speed_10m: null },
  daily_units: { time: 'iso8601', temperature_2m_min: '°C', temperature_2m_max: '°C', precipitation_probability_max: '%', weather_code: 'wmo code' },
  daily: { time: ['2026-10-23','2026-10-24','2026-10-25','2026-10-26','2026-10-27','2026-10-28','2026-10-29'], temperature_2m_min: [0,1,2,3,4,5,6], temperature_2m_max: [10,11,12,13,14,15,16], precipitation_probability_max: [0,10,null,30,40,50,60], weather_code: [0,1,2,3,45,51,61] },
  hourly_units: { time: 'iso8601', temperature_2m: '°C', precipitation_probability: '%', wind_speed_10m: 'km/h' },
  hourly: { time: ['2026-10-23T00:00','2026-10-23T01:00'], temperature_2m: [0,null], precipitation_probability: [0,10], wind_speed_10m: [0,2] },
};
const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
async function setup(t, fetchImpl, now = () => Date.parse('2026-10-23T04:00:00Z')) {
  const base = await mkdtemp(join(tmpdir(), 'weather-network-')), workspaceRoot = join(base, 'work');
  await mkdir(workspaceRoot);
  const service = createService({ dataDir: join(base,'data'), sessionId:'s', workspaceRoot, fetchImpl, now });
  t.after(async () => { service.close(); await rm(base,{recursive:true,force:true}); });
  return service;
}

test('requests only fixed weather endpoints with destination timezone, preserving real zero and missing values', async t => {
  const service = await setup(t, async (url, init) => {
    assert.equal(new URL(url).origin, 'https://api.open-meteo.com');
    assert.equal(new URL(url).searchParams.get('timezone'), 'Asia/Shanghai');
    assert.equal(new URL(url).searchParams.get('forecast_days'), '7');
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    return response(forecast);
  });
  const result = await service.invoke('GetForecast', {place});
  assert.equal(result.kind,'forecast'); assert.equal(result.timezone,'Asia/Shanghai');
  assert.deepEqual(result.current,{time:'2026-10-23T12:00',temperature:0,weatherCode:0,windSpeed:null});
  assert.equal(result.days.length,7); assert.equal(result.days[0].rainProbability,0); assert.equal(result.days[2].rainProbability,null);
  assert.equal(result.hours[0].temperature,0); assert.equal(result.hours[1].temperature,null); assert.equal(result.stale,false);
});

test('fresh forecast uses cache, failed refresh is marked stale, and a first failure never becomes demo weather', async t => {
  let calls = 0, clock = Date.parse('2026-10-23T04:00:00Z'), fail = false;
  const service = await setup(t, async () => { calls++; if(fail) throw new Error('offline'); return response(forecast); }, () => clock);
  await service.invoke('GetForecast',{place});
  await service.invoke('GetForecast',{place}); assert.equal(calls,1);
  fail = true; clock += 11*60*1000;
  const stale = await service.invoke('GetForecast',{place}); assert.equal(stale.stale,true); assert.equal(stale.current.temperature,0);
  clock += 25*60*60*1000;
  await assert.rejects(service.invoke('GetForecast',{place}), {code:'network_error'});
  await assert.rejects(service.invoke('GetForecast',{place:{...place,id:'new',latitude:1}}), {code:'network_error'});
});

test('city search encodes queries and normalizes only usable real places', async t => {
  const service = await setup(t, async url => {
    assert.equal(new URL(url).origin,'https://geocoding-api.open-meteo.com');
    assert.equal(new URL(url).searchParams.get('name'),'北京 & test');
    return response({ generationtime_ms:0.1, results:[{id:1816670,name:'Beijing',country:'China',latitude:39.9,longitude:116.4,timezone:'Asia/Shanghai',country_code:'CN',population:11716620},{id:2,name:'Unknown',latitude:0,longitude:0},null,{id:'x'.repeat(200),name:'Too long',latitude:0,longitude:0,timezone:'UTC'}] });
  });
  assert.deepEqual(await service.invoke('SearchPlaces',{query:'北京 & test'}),{kind:'places',places:[place]});
});

test('cache keeps a bounded number of destinations instead of retaining every search forever', async t => {
  let calls=0;
  const service=await setup(t,async()=>{calls++;return response(forecast);});
  for(let i=0;i<33;i++) await service.invoke('GetForecast',{place:{...place,latitude:i}});
  await service.invoke('GetForecast',{place:{...place,latitude:0}});
  assert.equal(calls,34);
});

test('rejects oversized and malformed responses, and cancellation does not return a cached success', async t => {
  let mode = 'valid';
  const service = await setup(t, async (url, init) => {
    if(mode === 'large') return new Response('x'.repeat(270_000));
    if(mode === 'malformed') return response({current:forecast.current});
    if(mode === 'abort') return new Promise((resolve,reject) => init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));
    return response(forecast);
  });
  mode='large'; await assert.rejects(service.invoke('GetForecast',{place}),{code:'response_too_large'});
  mode='malformed'; await assert.rejects(service.invoke('GetForecast',{place}),{code:'invalid_weather_data'});
  mode='valid'; await service.invoke('GetForecast',{place});
  mode='abort'; const controller=new AbortController();
  const pending=service.invoke('GetForecast',{place,force:true},controller.signal); controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
});
