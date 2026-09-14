export type SafeImageMediaType =
  "image/avif" | "image/bmp" | "image/gif" | "image/jpeg" | "image/png" | "image/webp"

export type SafeImageLayout = {
  width: number
  height: number
  frames: number
}

export type SafeImagePreviewDecision =
  | { ok: true; mediaType: SafeImageMediaType }
  | { ok: false; error: "image_too_large" | "image_unsupported" }

export const maxImagePreviewDimension = 8192
export const maxImagePreviewPixels = 16_777_216
export const maxImagePreviewFrames = 64

const mediaTypeByExtension: Readonly<Record<string, SafeImageMediaType>> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
}

export function safeImageMediaTypeFromName(name: string): SafeImageMediaType | null {
  const basename = name.split(/[\\/]/).pop() ?? name
  const dotIndex = basename.lastIndexOf(".")
  const extension = dotIndex >= 0 ? basename.slice(dotIndex).toLowerCase() : ""
  return mediaTypeByExtension[extension] ?? null
}

export function validateSafeImageBytes(
  bytes: Uint8Array,
  expectedMediaType: SafeImageMediaType
): SafeImageMediaType | null {
  const valid =
    expectedMediaType === "image/png"
      ? startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      : expectedMediaType === "image/jpeg"
        ? startsWithBytes(bytes, [0xff, 0xd8, 0xff])
        : expectedMediaType === "image/gif"
          ? startsWithAscii(bytes, "GIF87a") || startsWithAscii(bytes, "GIF89a")
          : expectedMediaType === "image/webp"
            ? startsWithAscii(bytes, "RIFF") && asciiAt(bytes, 8, "WEBP")
            : expectedMediaType === "image/bmp"
              ? startsWithAscii(bytes, "BM")
              : asciiAt(bytes, 4, "ftyp") &&
                (asciiAt(bytes, 8, "avif") || asciiAt(bytes, 8, "avis"))

  return valid ? expectedMediaType : null
}

export function isSafeImagePreviewLayout(layout: SafeImageLayout): boolean {
  const { width, height, frames } = layout
  if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(frames)) {
    return false
  }
  if (width < 1 || height < 1 || frames < 1) return false
  if (width > maxImagePreviewDimension || height > maxImagePreviewDimension) return false
  if (frames > maxImagePreviewFrames) return false
  return BigInt(width) * BigInt(height) * BigInt(frames) <= BigInt(maxImagePreviewPixels)
}

export function evaluateSafeImagePreview(
  expectedMediaType: SafeImageMediaType,
  layout: SafeImageLayout | null
): SafeImagePreviewDecision {
  if (!layout) return { ok: false, error: "image_unsupported" }
  if (!isSafeImagePreviewLayout(layout)) return { ok: false, error: "image_too_large" }
  return { ok: true, mediaType: expectedMediaType }
}

function startsWithBytes(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[index] === value)
}

function startsWithAscii(bytes: Uint8Array, expected: string): boolean {
  return asciiAt(bytes, 0, expected)
}

function asciiAt(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (bytes.byteLength < offset + expected.length) return false
  return [...expected].every(
    (character, index) => bytes[offset + index] === character.charCodeAt(0)
  )
}
