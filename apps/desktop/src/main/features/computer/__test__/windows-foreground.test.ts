import { describe, expect, it } from "vitest"
import { cropFromFrame, type ComputerForegroundFrame } from "../computer-platform"
import { foregroundInput } from "../windows-foreground"

const frame: ComputerForegroundFrame = {
  mimeType: "image/png", data: "", width: 400, height: 300, signature: "sample",
  geometry: { left: -900, top: 10, width: 800, height: 600, dpi: 144, monitor: "DISPLAY2" },
}

describe("Windows foreground input", () => {
  it("scales image pixels to the captured window and rejects out-of-frame clicks", () => {
    expect(foregroundInput({ type: "click", x: 399, y: 299 }, frame)).toEqual({
      type: "click", x: -102, y: 608, button: "left", geometry: frame.geometry, signature: frame.signature,
    })
    expect(foregroundInput({ type: "click", x: 400, y: 10 }, frame)).toBeUndefined()
    expect(foregroundInput({ type: "click", x: 0, y: 0 })).toBeUndefined()
    expect(foregroundInput({ type: "click", x: 0, y: 0 }, { ...frame, signature: undefined })).toBeUndefined()
  })

  it("maps both drag endpoints and refuses a drag outside the frame", () => {
    expect(foregroundInput({ type: "drag", x: 10, y: 20, toX: 300, toY: 200 }, frame)).toMatchObject({
      type: "drag", x: -880, y: 50, toX: -300, toY: 410,
    })
    expect(foregroundInput({ type: "drag", x: 10, y: 20, toX: 400, toY: 200 }, frame)).toBeUndefined()
  })

  it("keeps a double click and modifier clicks as individual gestures", () => {
    expect(foregroundInput({ type: "click", x: 10, y: 20, count: 2 }, frame)).toMatchObject({ count: 2 })
    expect(foregroundInput({ type: "click", x: 10, y: 20, modifiers: ["ctrl", "shift"] }, frame))
      .toMatchObject({ modifiers: [17, 16] })
  })

  it("maps coordinate wheel directions to signed Windows wheel deltas", () => {
    expect(foregroundInput({ type: "scroll_at", x: 10, y: 20, direction: "down", amount: 2 }, frame))
      .toMatchObject({ x: -880, y: 50, delta: -240, horizontal: false })
    expect(foregroundInput({ type: "scroll_at", x: 10, y: 20, direction: "right" }, frame))
      .toMatchObject({ delta: 120, horizontal: true })
  })

  it("maps a detail crop to unscaled pixels and clicks relative to its offset", () => {
    expect(cropFromFrame(frame, { x: 20, y: 30, width: 50, height: 60 })).toEqual({
      geometry: frame.geometry, region: { x: 40, y: 60, width: 100, height: 120 },
    })
    expect(cropFromFrame(frame, { x: 399, y: 10, width: 2, height: 20 })).toBeUndefined()
    expect(cropFromFrame(frame, { x: 20, y: 30, width: 0, height: 60 })).toBeUndefined()
    expect(foregroundInput({ type: "hover", x: 2, y: 3 }, { ...frame, width: 100, height: 120,
      region: { x: 40, y: 60, width: 100, height: 120 } })).toMatchObject({ type: "hover", x: -858, y: 73 })
  })

  it("does not translate system navigation shortcuts into foreground input", () => {
    const focusIdentity = "42,91,13"
    expect(foregroundInput({ type: "key", key: "F8", focusIdentity })).toMatchObject({ key: 119, modifiers: [] })
    expect(foregroundInput({ type: "key", key: "Tab", modifiers: ["alt"], focusIdentity })).toBeUndefined()
    expect(foregroundInput({ type: "key", key: "Delete", modifiers: ["ctrl", "alt"], focusIdentity })).toBeUndefined()
  })

  it("requires the observed accessible focus for keys and text", () => {
    const focusIdentity = "42,91,13"
    expect(foregroundInput({ type: "key", key: "F8" })).toBeUndefined()
    expect(foregroundInput({ type: "text", text: "sample" })).toBeUndefined()
    expect(foregroundInput({ type: "key", key: "F8", focusIdentity })).toMatchObject({ focusIdentity })
    expect(foregroundInput({ type: "text", text: "sample", focusIdentity })).toMatchObject({ focusIdentity })
  })
})
