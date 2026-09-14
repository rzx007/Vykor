import sharp from "sharp"

export async function createSolidPng(width: number, height: number): Promise<Uint8Array> {
  return uint8(
    await sharp({
      create: { width, height, channels: 3, background: "red" },
    })
      .png()
      .toBuffer()
  )
}

export async function createSolidJpeg(width: number, height: number): Promise<Uint8Array> {
  return uint8(
    await sharp({
      create: { width, height, channels: 3, background: "red" },
    })
      .jpeg()
      .toBuffer()
  )
}

export async function createSolidWebp(width: number, height: number): Promise<Uint8Array> {
  return uint8(
    await sharp({
      create: { width, height, channels: 3, background: "red" },
    })
      .webp()
      .toBuffer()
  )
}

export async function createSolidAvif(width: number, height: number): Promise<Uint8Array> {
  return uint8(
    await sharp({
      create: { width, height, channels: 3, background: "red" },
    })
      .avif()
      .toBuffer()
  )
}

export async function createPngDeclaringSize(width: number, height: number): Promise<Uint8Array> {
  const bytes = Uint8Array.from(await createSolidPng(1, 1))
  writeU32BE(bytes, 16, width)
  writeU32BE(bytes, 20, height)
  writeU32BE(bytes, 29, crc32(bytes.subarray(12, 29)))
  return bytes
}

export async function createJpegDeclaringSize(width: number, height: number): Promise<Uint8Array> {
  const bytes = Uint8Array.from(await createSolidJpeg(8, 8))
  const sof = bytes.findIndex((_, index) => bytes[index] === 0xff && bytes[index + 1] === 0xc0)
  if (sof < 0) throw new Error("JPEG SOF0 marker is missing")
  bytes[sof + 5] = (height >>> 8) & 0xff
  bytes[sof + 6] = height & 0xff
  bytes[sof + 7] = (width >>> 8) & 0xff
  bytes[sof + 8] = width & 0xff
  return bytes
}

export async function createWebpDeclaringSize(width: number, height: number): Promise<Uint8Array> {
  const bytes = Uint8Array.from(await createSolidWebp(8, 8))
  const start = indexOfAscii(bytes, "VP8 ")
  if (
    start < 0 ||
    bytes[start + 11] !== 0x9d ||
    bytes[start + 12] !== 0x01 ||
    bytes[start + 13] !== 0x2a
  ) {
    throw new Error("WebP VP8 start code is missing")
  }
  bytes[start + 14] = width & 0xff
  bytes[start + 15] = (width >>> 8) & 0x3f
  bytes[start + 16] = height & 0xff
  bytes[start + 17] = (height >>> 8) & 0x3f
  return bytes
}

export async function createAvifDeclaringSize(width: number, height: number): Promise<Uint8Array> {
  const bytes = Uint8Array.from(await createSolidAvif(8, 8))
  const start = indexOfAscii(bytes, "ispe")
  if (start < 0) throw new Error("AVIF ispe box is missing")
  writeU32BE(bytes, start + 8, width)
  writeU32BE(bytes, start + 12, height)
  return bytes
}

export function createBmpDeclaringSize(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(26)
  bytes.set([0x42, 0x4d], 0)
  writeU32LE(bytes, 2, 26)
  writeU32LE(bytes, 14, 40)
  writeU32LE(bytes, 18, width)
  writeU32LE(bytes, 22, height)
  return bytes
}

export function createGifDeclaringSize(width: number, height: number, frames: number): Uint8Array {
  const bytes = [...ascii("GIF89a"), ...u16leBytes(width), ...u16leBytes(height), 0, 0, 0]
  for (let index = 0; index < frames; index += 1) {
    bytes.push(
      0x2c,
      ...u16leBytes(0),
      ...u16leBytes(0),
      ...u16leBytes(width),
      ...u16leBytes(height),
      0,
      8,
      0
    )
  }
  bytes.push(0x3b)
  return new Uint8Array(bytes)
}

export function createAnimatedGif(frames: number): Uint8Array {
  const header = [
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xff, 0xff,
  ]
  const frame = [
    0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01,
    0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00,
  ]
  return new Uint8Array([...header, ...Array.from({ length: frames }, () => frame).flat(), 0x3b])
}

function uint8(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

function ascii(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0))
}

function indexOfAscii(bytes: Uint8Array, value: string): number {
  const needle = new Uint8Array(ascii(value))
  outer: for (let offset = 0; offset <= bytes.byteLength - needle.byteLength; offset += 1) {
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (bytes[offset + index] !== needle[index]) continue outer
    }
    return offset
  }
  return -1
}

function writeU32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff
  bytes[offset + 1] = (value >>> 16) & 0xff
  bytes[offset + 2] = (value >>> 8) & 0xff
  bytes[offset + 3] = value & 0xff
}

function writeU32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
  bytes[offset + 2] = (value >>> 16) & 0xff
  bytes[offset + 3] = (value >>> 24) & 0xff
}

function u16leBytes(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff]
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const value of bytes) {
    crc ^= value
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
