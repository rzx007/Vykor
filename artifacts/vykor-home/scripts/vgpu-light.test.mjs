import assert from 'node:assert/strict';
import test from 'node:test';
import { effect, frame, init, target } from 'vgpu/node';
import { prepareShader } from '@vgpu/wgsl/prepare';

// These tests read real GPU pixels: a blank shader, an opaque fullscreen wash,
// or a shader disconnected from the scroll state must all fail.
test('the paper receives localized spectral light that moves with the camera and fades on handoff', async t => {
  const { lightShader, lightUniforms } = await import('../src/vgpu-light-shader.js');
  let gpu;
  try { gpu = await init(); }
  catch (error) { t.skip(`No native WebGPU adapter: ${error.message}`); return; }
  const errors = [];
  gpu.onError(error => errors.push(error));
  try {
    const output = target(gpu, { size: [320, 240], format: 'rgba8unorm', clearColor: [0, 0, 0, 0] });
    const light = effect(gpu, prepareShader(lightShader), { set: { light: lightUniforms({ width: 320, height: 240, region: { left: 120, top: 35, width: 150, height: 160 } }) } });
    await light.compile(output);
    const render = async (progress, handoff = 0) => {
      light.set({ light: lightUniforms({ width: 320, height: 240, progress, handoff, region: { left: 120, top: 35, width: 150, height: 160 } }) });
      frame(gpu, current => current.pass({ target: output, clear: [0, 0, 0, 0] }, light));
      await gpu.settled();
      return new Uint8Array(await output.color.read({ mipLevel: 0, region: 'all' }));
    };
    const first = await render(0);
    assert.equal(errors.length, 0, errors.map(error => error.message).join('\n'));
    const alpha = first.filter((_, index) => index % 4 === 3);
    assert(alpha.some(value => value >= 12), 'The shader must leave visible light on paper.');
    assert(alpha.filter(value => value === 0).length > alpha.length * .60, 'Most of the page must remain fully transparent.');
    assert.equal(first[3], 0, 'The page corner must remain transparent.');
    const later = await render(.85);
    let changed = 0;
    for (let i = 0; i < first.length; i++) if (Math.abs(first[i] - later[i]) > 4) changed++;
    assert(changed > 150, 'Scroll must change the actual rendered pixels.');
    const hidden = await render(.85, 1);
    assert(hidden.every(value => value === 0), 'The light must fully fade when the model hands off.');
    light.dispose();
  } finally { gpu.dispose(); }
});

test('the browser entry safely declines devices without WebGPU', async () => {
  const { createVgpuLight } = await import('../src/vgpu-light.js');
  assert.equal(await createVgpuLight({ canvas: {} }), null);
});
