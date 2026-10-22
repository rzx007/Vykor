/**
 * Keep motion affordable, then spend more pixels on one settled frame.
 * Native CSS resolution is the floor unless the GPU's texture limit forbids it.
 */
export function chooseRenderQuality({
  width, height, devicePixelRatio = 1, mobile = false,
  settled = true, samples = 4, maxTextureSize = Infinity,
}) {
  const pixelBudget = settled
    ? (mobile ? 2_400_000 : 6_000_000)
    : (mobile ? 1_500_000 : 3_500_000);
  const minimumPreferred = settled ? (samples > 0 ? (mobile ? 1.5 : 1.75) : 2) : 1.25;
  const maximumPreferred = settled ? 2 : (mobile ? 1.25 : 1.5);
  const preferred = Math.min(maximumPreferred, Math.max(devicePixelRatio, minimumPreferred));
  const budgetRatio = Math.sqrt(pixelBudget / (width * height));
  const hardwareRatio = Math.min(maxTextureSize / width, maxTextureSize / height);
  return {
    pixelRatio: Math.min(hardwareRatio, Math.max(1, Math.min(preferred, budgetRatio))),
    transmissionResolutionScale: settled || !mobile ? 1 : .85,
  };
}
