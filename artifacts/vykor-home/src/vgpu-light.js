import { effect, frame, init, surface } from 'vgpu';
import { prepareShader } from '@vgpu/wgsl/prepare';
import { lightShader, lightUniforms } from './vgpu-light-shader.js';

let prepared;

/** A transparent, demand-rendered spectral light layer for the Three.js paper. */
export async function createVgpuLight({ canvas, onError, onLost, strength = 1 } = {}) {
  if (!canvas || !globalThis.navigator?.gpu) return null;
  let gpu;
  let output;
  let opticalLight;
  let unsubscribeError;
  let disposed = false;
  let frameCount = 0;

  const notify = (callback, error) => {
    try { callback?.(error); }
    catch { /* A host callback cannot keep a failed GPU layer alive. */ }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribeError?.();
    opticalLight?.dispose();
    output?.dispose();
    gpu?.dispose();
    if (canvas.dataset) canvas.dataset.engine = 'stopped';
  };
  const fail = error => {
    if (disposed) return;
    dispose();
    notify(onError, error);
  };

  try {
    gpu = await init({ powerPreference: 'low-power' });
    unsubscribeError = gpu.onError(fail);
    gpu.lost.then(info => {
      if (disposed) return;
      dispose();
      notify(onLost ?? onError, info);
    });
    output = surface(gpu, canvas, {
      label: 'Vykor paper light',
      autoResize: false,
      size: [1, 1],
      dpr: 1,
      alphaMode: 'premultiplied',
      clearColor: [0, 0, 0, 0],
    });
    prepared ??= prepareShader(lightShader, 'vykor-paper-light.wgsl');
    opticalLight = effect(gpu, prepared, {
      label: 'Vykor refracted spectrum',
      set: { light: lightUniforms({ strength }) },
    });
    // Compile before reporting a usable renderer; bad WGSL never creates a
    // successful-looking layer that only fails on the first scroll event.
    await opticalLight.compile(output);
    await gpu.settled();
    if (disposed) return null;
  } catch (error) {
    dispose();
    notify(onError, error);
    return null;
  }

  return {
    draw({ width, height, dpr = 1, ...state } = {}) {
      if (disposed || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
      try {
        const ratio = Math.max(.5, Math.min(1.5, Number.isFinite(dpr) ? dpr : 1));
        const limit = gpu.device.limits.maxTextureDimension2D;
        const fit = Math.min(ratio, limit / width, limit / height);
        const pixelWidth = Math.max(1, Math.round(width * fit));
        const pixelHeight = Math.max(1, Math.round(height * fit));
        const size = output.size;
        if (size[0] !== pixelWidth || size[1] !== pixelHeight) output.resize([pixelWidth, pixelHeight]);
        opticalLight.set({ light: lightUniforms({ width, height, strength, ...state }) });
        frame(gpu, current => current.pass({ target: output, clear: [0, 0, 0, 0] }, opticalLight));
        if (canvas.dataset) {
          canvas.dataset.engine = 'vgpu';
          canvas.dataset.frameCount = String(++frameCount);
        }
        return true;
      } catch (error) { fail(error); return false; }
    },
    dispose,
  };
}
