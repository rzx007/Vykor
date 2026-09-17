import type { ToolDefinition } from "@openharness/core";
import { sniffAttachmentMediaType } from "@openharness/services";

import type { AttachmentService } from "../attachments/attachment-service.js";
import {
  downloadRemoteImage as defaultDownloadRemoteImage,
  type ImportedImageSource,
} from "./remote-image-source.js";
import { createToolAbortScope } from "./tool-abort-scope.js";

const DEFAULT_MODEL = "agnes-image-2.5-flash";
const DEFAULT_BASE_URL = "https://api.agnes-ai.cn/v1";
const SIZE_VALUES = ["1K", "2K", "3K", "4K"] as const;
const RATIO_VALUES = ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"] as const;

export interface DaemonImageGenerationToolOptions {
  attachments: Pick<AttachmentService, "limits" | "import" | "delete">;
  downloadRemoteImage?: (
    url: URL,
    signal?: AbortSignal,
  ) => Promise<ImportedImageSource>;
}

interface GeneratedImageAsset {
  assetId: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
}

export function createDaemonImageGenerationTool(
  options: DaemonImageGenerationToolOptions,
): ToolDefinition {
  const downloadRemoteImage = options.downloadRemoteImage ?? defaultDownloadRemoteImage;
  return {
    name: "ImageGeneration",
    execution: {
      domain: "control_plane",
      supportedEnvironments: ["local", "wsl"],
      network: true,
    },
    description:
      "Generate or edit an image with Agnes Image 2.5 Flash. Use a text prompt for text-to-image, and optional reference image URLs or data URIs for image-to-image or multi-image composition. Returns durable image attachments.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Text instruction for generation or editing." },
        size: {
          type: "string",
          enum: [...SIZE_VALUES],
          description: "Output resolution tier. Default: 1K.",
        },
        ratio: {
          type: "string",
          enum: [...RATIO_VALUES],
          description: "Output aspect ratio used with size. Default: 1:1.",
        },
        images: {
          type: "array",
          items: { type: "string" },
          description: "Reference images as public HTTPS URLs or data:image/...;base64,... URIs.",
        },
        model: {
          type: "string",
          description: `Optional model override. Defaults to ${DEFAULT_MODEL}.`,
        },
      },
      required: ["prompt"],
    },
    async execute(input, context) {
      const prompt = readRequiredString(input.prompt, "prompt");
      if ("error" in prompt) return policyError(prompt.error);
      const size = readEnum(input.size, SIZE_VALUES, "1K");
      if ("error" in size) return policyError(size.error);
      const ratio = readEnum(input.ratio, RATIO_VALUES, "1:1");
      if ("error" in ratio) return policyError(ratio.error);
      const images = readImages(input.images);
      if ("error" in images) return policyError(images.error);
      const model = optionalString(input.model) ??
        optionalString(process.env.AGNES_IMAGE_MODEL) ??
        DEFAULT_MODEL;
      const apiKey = process.env.AGNES_API_KEY?.trim() ?? "";
      if (!apiKey) {
        return policyError(
          "ImageGeneration is unavailable because AGNES_API_KEY is not configured.",
        );
      }
      const baseUrl = optionalString(process.env.AGNES_IMAGE_BASE_URL) ?? DEFAULT_BASE_URL;

      const generationAbortScope = createToolAbortScope(context.abortSignal, 1980_000);
      try {
        const response = await fetch(imagesGenerationsUrl(baseUrl), {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(buildAgnesRequest({
            model,
            prompt: prompt.value,
            size: size.value,
            ratio: ratio.value,
            images: images.value,
          })),
          signal: generationAbortScope.signal,
        });
        if (!response.ok) {
          const body = redactProviderBody(await response.text(), apiKey);
          return {
            content: [{
              type: "text",
              text: providerFailureText(
                response.status,
                body,
                response.headers.get("retry-after"),
              ),
            }],
            isError: true,
            failureKind: "provider",
          };
        }

        const json = await response.json() as {
          data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
        };
        if (!json.data?.length) {
          return { content: [{ type: "text", text: "ImageGeneration: no images returned" }], isError: true };
        }

        const generatedImages: GeneratedImageAsset[] = [];
        const importedAssetIds: string[] = [];
        try {
          for (const [index, item] of json.data.entries()) {
            let source: ImportedImageSource;
            if (item.b64_json) {
              const bytes = Buffer.from(item.b64_json, "base64");
              if (bytes.byteLength > options.attachments.limits.maxBytesPerFile) {
                throw new Error(
                  `generated image exceeds the ${options.attachments.limits.maxBytesPerFile} byte attachment limit`,
                );
              }
              const mediaType = sniffAttachmentMediaType(bytes, undefined, true);
              if (!mediaType.startsWith("image/")) {
                throw new Error("provider returned base64 content that is not a supported image");
              }
              source = {
                displayName: `generated-image-${index + 1}.${imageExtension(mediaType)}`,
                declaredMediaType: mediaType,
                content: streamOf(bytes),
              };
            } else if (item.url) {
              const downloadAbortScope = createToolAbortScope(context.abortSignal, 60_000);
              try {
                const downloaded = await downloadRemoteImage(
                  new URL(item.url),
                  downloadAbortScope.signal,
                );
                source = {
                  ...downloaded,
                  displayName: `generated-image-${index + 1}.${imageExtension(
                    downloaded.declaredMediaType,
                  )}`,
                };
              } finally {
                downloadAbortScope.dispose();
              }
            } else {
              continue;
            }

            const asset = await options.attachments.import({
              displayName: source.displayName,
              ...(source.declaredMediaType
                ? { declaredMediaType: source.declaredMediaType }
                : {}),
              content: source.content,
              signal: context.abortSignal,
            });
            importedAssetIds.push(asset.id);
            if (
              asset.status !== "ready" ||
              !asset.mediaType?.startsWith("image/") ||
              asset.sizeBytes === undefined
            ) {
              throw new Error("generated attachment did not become a ready image asset");
            }
            generatedImages.push({
              assetId: asset.id,
              displayName: asset.displayName,
              mediaType: asset.mediaType,
              sizeBytes: asset.sizeBytes,
            });
          }
        } catch (error) {
          for (const assetId of importedAssetIds.reverse()) {
            try {
              options.attachments.delete(assetId);
            } catch {
              // Preserve the original import failure; attachment repair can reconcile leftovers.
            }
          }
          throw error;
        }

        if (generatedImages.length === 0) {
          return {
            content: [{ type: "text", text: "ImageGeneration: no usable images returned" }],
            isError: true,
            failureKind: "provider",
          };
        }

        const revisedPrompt = json.data[0]?.revised_prompt;
        let text = generatedImages
          .map((image, index) => `Generated image ${index + 1}: attachment ${image.assetId}`)
          .join("\n");
        if (revisedPrompt) text += `\nRevised prompt: ${revisedPrompt}`;
        return {
          content: [{ type: "text", text }],
          metadata: { generatedImages },
        };
      } catch (error) {
        const interrupted = context.abortSignal?.aborted === true;
        const detail = redactProviderBody(formatThrownError(error), apiKey);
        return {
          content: [{
            type: "text",
            text: interrupted
              ? `ImageGeneration interrupted: ${detail}`
              : `ImageGeneration request failed: ${detail}`,
          }],
          isError: true,
          failureKind: interrupted ? "interrupted" : "provider",
        };
      } finally {
        generationAbortScope.dispose();
      }
    },
  };
}

function buildAgnesRequest(input: {
  model: string;
  prompt: string;
  size: string;
  ratio: string;
  images: string[];
}): Record<string, unknown> {
  if (input.images.length === 0) {
    return {
      model: input.model,
      prompt: input.prompt,
      size: input.size,
      ratio: input.ratio,
      return_base64: true,
    };
  }
  return {
    model: input.model,
    prompt: input.prompt,
    size: input.size,
    ratio: input.ratio,
    extra_body: {
      image: input.images,
      response_format: "b64_json",
    },
  };
}

function imagesGenerationsUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, "");
  return root.endsWith("/v1") ? `${root}/images/generations` : `${root}/v1/images/generations`;
}

function readRequiredString(value: unknown, field: string): { value: string } | { error: string } {
  if (typeof value !== "string" || !value.trim()) return { error: `${field} is required.` };
  return { value: value.trim() };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): { value: T } | { error: string } {
  if (value === undefined) return { value: fallback };
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return { value: value as T };
  }
  return { error: `Unsupported value: ${String(value)}` };
}

function readImages(value: unknown): { value: string[] } | { error: string } {
  if (value === undefined) return { value: [] };
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    return { error: "images must be an array of image URLs or data URIs." };
  }
  return { value: value.map((item) => item.trim()) };
}

function policyError(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
    failureKind: "policy" as const,
  };
}

function redactProviderBody(body: string, apiKey: string): string {
  const redacted = apiKey ? body.split(apiKey).join("[redacted]") : body;
  return redacted.slice(0, 1_000);
}

function providerFailureText(status: number, body: string, retryAfter: string | null): string {
  if (status === 401 || status === 403) {
    return `ImageGeneration credentials rejected (HTTP ${status}): ${body}`;
  }
  if (status === 429) {
    const retry = retryAfter?.trim()
      ? ` Retry after ${retryAfter.trim()} seconds; do not retry before then.`
      : " Wait before retrying; do not retry immediately.";
    return `ImageGeneration rate limited (HTTP 429).${retry} ${body}`;
  }
  return `ImageGeneration provider error ${status}: ${body}`;
}

function formatThrownError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name || "Error"}: ${error.message || "No error message"}`;
  }
  return `Unknown error: ${String(error)}`;
}

function imageExtension(mediaType: string | undefined): string {
  switch (mediaType?.toLowerCase()) {
    case "image/jpeg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    case "image/bmp": return "bmp";
    default: return "png";
  }
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
