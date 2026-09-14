import sharp from "sharp"

import {
  evaluateSafeImagePreview,
  validateSafeImageBytes,
  type SafeImageLayout,
  type SafeImageMediaType,
  type SafeImagePreviewDecision,
} from "@shared/safe-image-preview"

const sharpFormatByMediaType: Partial<Record<SafeImageMediaType, string>> = {
  "image/avif": "heif",
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
}

export async function inspectSafeImageLayout(
  bytes: Uint8Array,
  mediaType: SafeImageMediaType
): Promise<SafeImageLayout | null> {
  if (!validateSafeImageBytes(bytes, mediaType)) return null
  if (mediaType === "image/bmp") return parseBmpLayout(bytes)
  if (mediaType === "image/gif") return parseGifLayout(bytes)
  return inspectWithSharp(bytes, mediaType)
}

export async function evaluateInspectedImagePreview(
  bytes: Uint8Array,
  mediaType: SafeImageMediaType
): Promise<SafeImagePreviewDecision> {
  return evaluateSafeImagePreview(mediaType, await inspectSafeImageLayout(bytes, mediaType))
}

async function inspectWithSharp(
  bytes: Uint8Array,
  mediaType: SafeImageMediaType
): Promise<SafeImageLayout | null> {
  try {
    const metadata = await sharp(toSharpBuffer(bytes), {
      animated: true,
      limitInputPixels: false,
    }).metadata()
    if (metadata.format !== sharpFormatByMediaType[mediaType]) return null
    return toLayout(metadata.width ?? 0, metadata.height ?? 0, metadata.pages ?? 1)
  } catch {
    return null
  }
}

function parseGifLayout(bytes: Uint8Array): SafeImageLayout | null {
  if (bytes.byteLength < 13) return null
  const width = u16le(bytes, 6)
  const height = u16le(bytes, 8)
  const packed = bytes[10] ?? 0
  let offset = 13
  if (packed & 0x80) offset += 3 * 2 ** ((packed & 7) + 1)
  let frames = 0
  while (offset < bytes.byteLength) {
    const block = bytes[offset]
    if (block === 0x3b) break
    if (block === 0x2c) {
      if (offset + 10 > bytes.byteLength) break
      frames += 1
      const localPacked = bytes[offset + 9] ?? 0
      offset += 10
      if (localPacked & 0x80) offset += 3 * 2 ** ((localPacked & 7) + 1)
      offset += 1
      offset = skipGifSubBlocks(bytes, offset)
      continue
    }
    if (block === 0x21) {
      offset += 2
      offset = skipGifSubBlocks(bytes, offset)
      continue
    }
    offset += 1
  }
  return toLayout(width, height, Math.max(frames, 1))
}

function skipGifSubBlocks(bytes: Uint8Array, start: number): number {
  let offset = start
  while (offset < bytes.byteLength) {
    const size = bytes[offset] ?? 0
    if (size === 0) return offset + 1
    offset += 1 + size
  }
  return offset
}

function parseBmpLayout(bytes: Uint8Array): SafeImageLayout | null {
  if (bytes.byteLength < 26) return null
  const headerSize = u32le(bytes, 14)
  if (headerSize === 12) {
    if (bytes.byteLength < 22) return null
    return toLayout(u16le(bytes, 18), u16le(bytes, 20), 1)
  }
  const width = i32le(bytes, 18)
  const height = Math.abs(i32le(bytes, 22))
  if (width < 1) return null
  return toLayout(width, height, 1)
}

function toLayout(width: number, height: number, frames: number): SafeImageLayout | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(frames)) {
    return null
  }
  if (width < 1 || height < 1 || frames < 1) return null
  return { width, height, frames }
}

function toSharpBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function u16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  )
}

function i32le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  )
}
