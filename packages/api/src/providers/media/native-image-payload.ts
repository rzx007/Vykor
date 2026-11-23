import type { ContentBlock, StreamMessageParams } from "@vykor/agent-contracts";
import { access } from "node:fs/promises";
import { basename } from "node:path";

import {
  type PreparedVisionImage,
  VisionImagePreparer,
} from "./vision-image-preparer.js";
import { assertNativeImageMediaType } from "../registry.js";

export const sharedVisionImagePreparer = new VisionImagePreparer();

export function hasMemoryImages(params: StreamMessageParams): boolean {
  return params.messages.some(message => (message.type === "tool_result" || message.type === "user")
    && Array.isArray(message.content)
    && message.content.some(block => block.type === "image" && block.source.type === "memory"));
}

/** Providers call this directly before dispatch, after any asynchronous image conversion. */
export function withoutRevokedMemoryImages(params: StreamMessageParams): StreamMessageParams {
  if (params.isEphemeralImageCurrent?.() !== false) return params;
  return {
    ...params,
    messages: params.messages.map(message => {
      if ((message.type !== "tool_result" && message.type !== "user") || typeof message.content === "string") return message;
      return {
        ...message,
        content: message.content.filter(block => block.type !== "image" || block.source.type !== "memory"),
      };
    }),
  };
}

export async function replaceMissingToolResultImages(
  content: ContentBlock[],
): Promise<ContentBlock[]> {
  return Promise.all(content.map(async (block): Promise<ContentBlock> => {
    if (block.type !== "image" || block.source.type === "memory") return block;
    try {
      await access(block.source.path);
      return block;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        type: "text",
        text: `[Historical image unavailable: ${basename(block.source.path)}]`,
      };
    }
  }));
}

export async function prepareUserContentWithVisionImages(
  content: string | ContentBlock[],
  options?: { signal?: AbortSignal },
): Promise<string | ContentBlock[]> {
  if (typeof content === "string") return content;
  return Promise.all(content.map(async (block): Promise<ContentBlock> => {
    if (block.type !== "image" || block.source.type === "memory") return block;
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
  if (block.source.type === "memory") {
    signal?.throwIfAborted();
    const { data, mediaType, width, height } = block.source;
    return Promise.resolve({
      base64: data,
      mediaType,
      width,
      height,
      encodedBytes: Buffer.byteLength(data, "base64"),
      base64Bytes: data.length,
      policyVersion: "host-memory",
    });
  }
  return sharedVisionImagePreparer.prepare(
    block.source.path,
    block.source.mediaType,
    signal,
  );
}

export function preparedImageDataUrl(image: PreparedVisionImage): string {
  return `data:${image.mediaType};base64,${image.base64}`;
}
