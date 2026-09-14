import { describe, expect, it } from "vitest"

import { inspectSafeImageLayout } from "./inspect-safe-image-layout"
import {
  createAnimatedGif,
  createAvifDeclaringSize,
  createBmpDeclaringSize,
  createGifDeclaringSize,
  createJpegDeclaringSize,
  createPngDeclaringSize,
  createSolidAvif,
  createSolidJpeg,
  createSolidPng,
  createSolidWebp,
  createWebpDeclaringSize,
} from "./safe-image-test-bytes"

describe("inspectSafeImageLayout", () => {
  it("reads ordinary preview-sized images through sharp", async () => {
    expect(await inspectSafeImageLayout(await createSolidPng(32, 24), "image/png")).toEqual({
      width: 32,
      height: 24,
      frames: 1,
    })
    expect(await inspectSafeImageLayout(await createSolidJpeg(64, 48), "image/jpeg")).toEqual({
      width: 64,
      height: 48,
      frames: 1,
    })
    expect(await inspectSafeImageLayout(await createSolidWebp(16, 12), "image/webp")).toEqual({
      width: 16,
      height: 12,
      frames: 1,
    })
    expect(await inspectSafeImageLayout(await createSolidAvif(16, 12), "image/avif")).toEqual({
      width: 16,
      height: 12,
      frames: 1,
    })
  })

  it("reads compact GIF and BMP headers that sharp cannot inspect safely", async () => {
    expect(await inspectSafeImageLayout(createGifDeclaringSize(16, 12, 2), "image/gif")).toEqual({
      width: 16,
      height: 12,
      frames: 2,
    })
    expect(await inspectSafeImageLayout(createBmpDeclaringSize(48, 32), "image/bmp")).toEqual({
      width: 48,
      height: 32,
      frames: 1,
    })
  })

  it("reads compressed pixel-bomb headers before decode", async () => {
    expect(
      await inspectSafeImageLayout(await createPngDeclaringSize(32_768, 32_768), "image/png")
    ).toEqual({
      width: 32_768,
      height: 32_768,
      frames: 1,
    })
    expect(
      await inspectSafeImageLayout(await createJpegDeclaringSize(32_768, 32_768), "image/jpeg")
    ).toEqual({
      width: 32_768,
      height: 32_768,
      frames: 1,
    })
    expect(
      await inspectSafeImageLayout(await createWebpDeclaringSize(16_383, 16_383), "image/webp")
    ).toEqual({
      width: 16_383,
      height: 16_383,
      frames: 1,
    })
    expect(
      await inspectSafeImageLayout(await createAvifDeclaringSize(32_768, 32_768), "image/avif")
    ).toEqual({
      width: 32_768,
      height: 32_768,
      frames: 1,
    })
    expect(
      await inspectSafeImageLayout(createGifDeclaringSize(32_768, 32_768, 1), "image/gif")
    ).toEqual({
      width: 32_768,
      height: 32_768,
      frames: 1,
    })
    expect(
      await inspectSafeImageLayout(createBmpDeclaringSize(32_768, 32_768), "image/bmp")
    ).toEqual({
      width: 32_768,
      height: 32_768,
      frames: 1,
    })
    expect(await inspectSafeImageLayout(createAnimatedGif(65), "image/gif")).toEqual({
      width: 1,
      height: 1,
      frames: 65,
    })
  })

  it("does not treat a signature-only file as a readable layout", async () => {
    expect(
      await inspectSafeImageLayout(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/png"
      )
    ).toBeNull()
  })
})
