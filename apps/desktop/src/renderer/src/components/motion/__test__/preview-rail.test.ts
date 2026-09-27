import { describe, expect, it } from "vitest"

import {
  resolveTickScale,
  TICK_SCALE_BASE,
  TICK_SCALE_FAR,
  TICK_SCALE_HOVER,
  TICK_SCALE_NEAR,
} from "../preview-rail-scale"

describe("resolveTickScale", () => {
  it("keeps every tick small while idle", () => {
    expect(resolveTickScale(false, false, Number.POSITIVE_INFINITY, 0.3)).toBe(TICK_SCALE_BASE)
  })

  it("marks the active tick with its own scale while idle", () => {
    expect(resolveTickScale(true, false, 0, 0.3)).toBe(0.3)
  })

  it("builds the pyramid only while hovering", () => {
    expect(resolveTickScale(true, true, 0, 0.3)).toBe(TICK_SCALE_HOVER)
    expect(resolveTickScale(false, true, 1, 0.3)).toBe(TICK_SCALE_NEAR)
    expect(resolveTickScale(false, true, 2, 0.3)).toBe(TICK_SCALE_FAR)
    expect(resolveTickScale(false, true, 3, 0.3)).toBe(TICK_SCALE_BASE)
  })
})
