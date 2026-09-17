import sharp from "sharp";

import { LocalOcrError, normalizeLocalOcrError } from "./local-ocr-errors.js";

export interface OcrImageLimits {
  maxEncodedBytes: number;
  maxPixels: number;
  maxSide: number;
}

export interface NormalizedOcrImage {
  bytes: Uint8Array;
  mediaType: string;
  width: number;
  height: number;
  normalized: boolean;
}

const defaults: OcrImageLimits = {
  maxEncodedBytes: 40 * 1024 * 1024,
  maxPixels: 40_000_000,
  maxSide: 16_384,
};

export async function normalizeOcrImage(
  bytes: Uint8Array,
  mediaType: string,
  limits: Partial<OcrImageLimits> = {},
): Promise<NormalizedOcrImage> {
  const effective = { ...defaults, ...limits };
  if (bytes.byteLength > effective.maxEncodedBytes) throw resourceLimit();
  try {
    const image = sharp(bytes, { animated: false, limitInputPixels: false });
    const metadata = await image.metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width <= 0 || height <= 0) throw new LocalOcrError("ocr_invalid_image", "Image dimensions are missing");
    if (width > effective.maxSide || height > effective.maxSide || width * height > effective.maxPixels) {
      throw resourceLimit();
    }
    const direct = mediaType === "image/png" || mediaType === "image/jpeg";
    if (direct) return { bytes: new Uint8Array(bytes), mediaType, width, height, normalized: false };
    if (!["image/gif", "image/webp", "image/bmp"].includes(mediaType)) {
      throw new LocalOcrError("ocr_invalid_image", `Unsupported OCR image type: ${mediaType}`);
    }
    const normalized = await image.rotate().png().toBuffer();
    return { bytes: normalized, mediaType: "image/png", width, height, normalized: true };
  } catch (error) {
    if (error instanceof LocalOcrError) throw error;
    const normalized = normalizeLocalOcrError(error);
    if (normalized.code === "ocr_inference_failed") {
      throw new LocalOcrError("ocr_invalid_image", "The attachment is not a valid image");
    }
    throw normalized;
  }
}

function resourceLimit(): LocalOcrError {
  return new LocalOcrError("ocr_resource_limit_exceeded", "The image exceeds OCR resource limits");
}
