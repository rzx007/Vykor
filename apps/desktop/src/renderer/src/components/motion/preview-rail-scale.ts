export const TICK_SCALE_BASE = 0.18
export const TICK_SCALE_HOVER = 0.7
export const TICK_SCALE_NEAR = 0.45
export const TICK_SCALE_FAR = 0.28

export function resolveTickScale(
  highlighted: boolean,
  hovering: boolean,
  distance: number,
  activeScale: number
): number {
  if (highlighted) return hovering ? TICK_SCALE_HOVER : activeScale
  if (!hovering) return TICK_SCALE_BASE
  if (distance === 1) return TICK_SCALE_NEAR
  if (distance === 2) return TICK_SCALE_FAR
  return TICK_SCALE_BASE
}
