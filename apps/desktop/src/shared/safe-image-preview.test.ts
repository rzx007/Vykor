import { describe, expect, it } from "vitest"

import {
  safeImageMediaTypeFromName,
  validateSafeImageBytes,
  type SafeImageMediaType,
} from "./safe-image-preview"

describe("safe image preview", () => {
  it.each([
    ["a.png", "image/png"],
    ["a.jpg", "image/jpeg"],
    ["a.jpeg", "image/jpeg"],
    ["a.gif", "image/gif"],
    ["a.webp", "image/webp"],
    ["a.bmp", "image/bmp"],
    ["a.avif", "image/avif"],
    ["A.PNG", "image/png"],
  ] as const)("maps %s to %s", (name, mediaType) => {
    expect(safeImageMediaTypeFromName(name)).toBe(mediaType)
  })

  it("does not classify active or unsupported formats as safe bitmaps", () => {
    expect(safeImageMediaTypeFromName("active.svg")).toBeNull()
    expect(safeImageMediaTypeFromName("icon.ico")).toBeNull()
    expect(safeImageMediaTypeFromName("page.html")).toBeNull()
  })

  it.each([
    ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ["image/jpeg", [0xff, 0xd8, 0xff]],
    ["image/gif", ascii("GIF87a")],
    ["image/gif", ascii("GIF89a")],
    ["image/webp", [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")]],
    ["image/bmp", ascii("BM")],
    ["image/avif", [0, 0, 0, 0, ...ascii("ftyp"), ...ascii("avif")]],
    ["image/avif", [0, 0, 0, 0, ...ascii("ftyp"), ...ascii("avis")]],
  ] as const)("accepts bytes matching %s", (mediaType, values) => {
    expect(validateSafeImageBytes(new Uint8Array(values), mediaType)).toBe(mediaType)
  })

  it("rejects active content and mismatched signatures", () => {
    const activeContent = new TextEncoder().encode('<svg onload="alert(1)"></svg>')

    expect(validateSafeImageBytes(activeContent, "image/png")).toBeNull()
    expect(validateSafeImageBytes(new Uint8Array(ascii("GIF89a")), "image/jpeg")).toBeNull()
  })

  it("rejects truncated signatures", () => {
    const mediaTypes: SafeImageMediaType[] = [
      "image/avif",
      "image/bmp",
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]

    for (const mediaType of mediaTypes) {
      expect(validateSafeImageBytes(new Uint8Array(), mediaType)).toBeNull()
    }
  })
})

function ascii(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0))
}
