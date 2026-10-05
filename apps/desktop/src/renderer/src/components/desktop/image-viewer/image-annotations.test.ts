import { describe, expect, it } from "vitest"
import { imageAnnotationKey, parseImageRegions, imageFeedbackText } from "./image-annotations"

describe("image annotation snapshots", () => {
  it("binds saved regions to image contents rather than the display name", async () => {
    expect(await imageAnnotationKey(new Uint8Array([1, 2]).buffer)).toBe(
      await imageAnnotationKey(new Uint8Array([1, 2]).buffer)
    )
    expect(await imageAnnotationKey(new Uint8Array([1, 3]).buffer)).not.toBe(
      await imageAnnotationKey(new Uint8Array([1, 2]).buffer)
    )
  })

  it("rejects malformed and out-of-image saved regions", () => {
    expect(parseImageRegions("{broken", 200, 100)).toEqual([])
    expect(
      parseImageRegions(
        JSON.stringify([{ id: "a", x: 190, y: 5, width: 20, height: 10, comment: "意见" }]),
        200,
        100
      )
    ).toEqual([])
    expect(
      parseImageRegions(
        JSON.stringify([{ id: "a", x: 10, y: 5, width: 20, height: 10, comment: "意见" }]),
        200,
        100
      )
    ).toEqual([{ id: "a", x: 10, y: 5, width: 20, height: 10, comment: "意见" }])
  })

  it("numbers only comments that will be sent and preserves original pixel coordinates", () => {
    const text = imageFeedbackText(
      "screen.png",
      [
        { id: "empty", x: 0, y: 0, width: 5, height: 5, comment: "  " },
        { id: "target", x: 100, y: 40, width: 60, height: 20, comment: "增加间距" },
      ],
      400,
      200
    )
    expect(text).toContain("1. 区域 (100, 40, 60, 20)：增加间距")
    expect(text).toContain("400 × 200")
    expect(text).not.toContain("2. 区域")
  })
})
