import type { ContentBlock } from "@vykor/core";

import {
  type PreparedVisionImage,
  VisionImagePreparer,
} from "./vision-image-preparer.js";
import { assertNativeImageMediaType } from "./registry.js";

export const sharedVisionImagePreparer = new VisionImagePreparer();

export async function prepareUserContentWithVisionImages(
  content: string | ContentBlock[],
  options?: { signal?: AbortSignal },
): Promise<string | ContentBlock[]> {
  if (typeof content === "string") return content;
  return Promise.all(content.map(async (block): Promise<ContentBlock> => {
    if (block.type !== "image") return block;
    const prepared = await prepareNativeImagePayload(block, options?.signal);
    return {
      ...block,
      source: {
        ...block.source,
        prepared: {
          mediaType: prepared.mediaType,
          width: prepared.width,
          height: prepared.height,
          base64Bytes: prepared.base64Bytes,
          policyVersion: prepared.policyVersion,
        },
      },
    };
  }));
}

export function prepareNativeImagePayload(
  block: Extract<ContentBlock, { type: "image" }>,
  signal?: AbortSignal,
): Promise<PreparedVisionImage> {
  assertNativeImageMediaType(block.source.mediaType);
  return sharedVisionImagePreparer.prepare(
    block.source.path,
    block.source.mediaType,
    signal,
  );
}

export function preparedImageDataUrl(image: PreparedVisionImage): string {
  return `data:${image.mediaType};base64,${image.base64}`;
}
