import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseRenderQuality } from '../src/render-quality.js';

test('a settled ordinary desktop gets real supersampling even at device DPR 1', () => {
  const quality = chooseRenderQuality({ width: 1440, height: 900, devicePixelRatio: 1, settled: true, samples: 4 });
  assert(quality.pixelRatio >= 1.75, 'A native-resolution MSAA canvas still needs more spatial detail.');
  assert.equal(quality.transmissionResolutionScale, 1, 'Glass must not refract a deliberately undersized source.');
});

test('a 2560px canvas no longer renders below its native CSS resolution', () => {
  const quality = chooseRenderQuality({ width: 2560, height: 1440, devicePixelRatio: 1, settled: true });
  assert(quality.pixelRatio >= 1);
  assert(2560 * 1440 * quality.pixelRatio ** 2 <= 6_000_000 + 1e-6);
});

test('a native 4K canvas preserves native detail instead of shrinking to the old pixel budget', () => {
  const quality = chooseRenderQuality({ width: 3840, height: 2160, devicePixelRatio: 1, settled: true });
  assert.equal(quality.pixelRatio, 1);
});

test('settling adds detail without rendering every animation frame at the final cost', () => {
  const viewport = { width: 1600, height: 900, devicePixelRatio: 2, samples: 4 };
  const moving = chooseRenderQuality({ ...viewport, settled: false });
  const still = chooseRenderQuality({ ...viewport, settled: true });
  assert(moving.pixelRatio >= 1);
  assert(still.pixelRatio > moving.pixelRatio);
  assert(viewport.width * viewport.height * moving.pixelRatio ** 2 <= 3_500_000 + 1e-6);
  assert(viewport.width * viewport.height * still.pixelRatio ** 2 <= 6_000_000 + 1e-6);
});

test('phones supersample within their smaller pixel budget', () => {
  const viewport = { width: 390, height: 844, devicePixelRatio: 3, mobile: true, settled: true };
  const quality = chooseRenderQuality(viewport);
  assert(quality.pixelRatio > 1.2, 'The previous mobile cap left visible staircase edges.');
  assert(quality.pixelRatio <= 2);
  assert(viewport.width * viewport.height * quality.pixelRatio ** 2 <= 2_400_000 + 1e-6);
});

test('missing native MSAA requests stronger settled supersampling when the budget permits', () => {
  const withMsaa = chooseRenderQuality({ width: 1200, height: 800, devicePixelRatio: 1, samples: 4, settled: true });
  const withoutMsaa = chooseRenderQuality({ width: 1200, height: 800, devicePixelRatio: 1, samples: 0, settled: true });
  assert(withoutMsaa.pixelRatio > withMsaa.pixelRatio);
  assert.equal(withoutMsaa.pixelRatio, 2);
});

test('hardware texture limits override the native-resolution floor', () => {
  const quality = chooseRenderQuality({ width: 10000, height: 2000, maxTextureSize: 8192, settled: true });
  assert(10000 * quality.pixelRatio <= 8192);
  assert(2000 * quality.pixelRatio <= 8192);
});
