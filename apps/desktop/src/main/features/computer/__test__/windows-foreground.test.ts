import { describe, expect, it } from "vitest"
import { foregroundInput, type WindowsForegroundFrame } from "../windows-foreground"

const frame: WindowsForegroundFrame = {
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
