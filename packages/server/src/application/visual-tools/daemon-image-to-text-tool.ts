import { extname } from "node:path";
import type {
  Settings,
  ToolContext,
  ToolDefinition,
  ToolFailureKind,
  ToolResult,
} from "@vykor/core";

import type {
  AttachmentAuthorizationSessionResolver,
  AttachmentOcrService,
} from "../attachments/tools/attachment-access.js";
import { createToolAbortScope } from "./tool-abort-scope.js";

const MAX_DESCRIPTION_TOKENS = 1_024;
const MEDIA_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function createDaemonImageToTextTool(options: {
  authorizationSessions: AttachmentAuthorizationSessionResolver;
  attachmentOcr: AttachmentOcrService;
}): ToolDefinition {
  return {
    name: "ImageToText",
    execution: {
      domain: "control_plane",
      supportedEnvironments: ["local", "wsl"],
    },
    description:
      "Describe an image or extract visible text. Accepts an authorized daemon attachment, a local image path, or a public HTTP(S) image URL.",
    inputSchema: {
      type: "object",
      properties: {
        attachment_id: { type: "string", description: "Authorized daemon attachment asset ID for local OCR." },
        image_path: { type: "string", description: "Local jpg, jpeg, png, gif, or webp path." },
        image_url: { type: "string", description: "Public HTTP(S) image URL." },
        prompt: { type: "string", description: "Vision instruction for image_path or image_url." },
      },
      additionalProperties: false,
      oneOf: [
        { required: ["attachment_id"] },
        { required: ["image_path"] },
        { required: ["image_url"] },
      ],
    },
    async execute(input, context) {
      if ("attachment_id" in input) {
        return await recognizeAttachment(input, context, options);
      }

      const parsed = parseVisionInput(input, context.cwd);
      if (typeof parsed === "string") return errorResult(parsed, "command");
      if (!context.settings) {
        return errorResult("ImageToText is unavailable because runtime settings are missing.", "policy");
      }
      if (parsed.imageUrl && context.environment?.info.networkMode === "none") {
        return errorResult("ImageToText URL access is disabled by the execution environment network policy.", "policy");
      }

      let imageBlock: Record<string, unknown>;
      try {
        imageBlock = await buildImageBlock(parsed, context.settings.apiFormat, context);
      } catch (error) {
        return errorResult(safeMessage(error), "command");
      }

      const abortScope = createToolAbortScope(context.abortSignal, 60_000);
      try {
        return await requestDescription(
          context.settings,
          imageBlock,
          parsed.prompt,
          abortScope.signal,
        );
      } catch {
        return errorResult(
          context.abortSignal?.aborted ? "ImageToText was interrupted." : "ImageToText request failed.",
          context.abortSignal?.aborted ? "interrupted" : "provider",
        );
      } finally {
        abortScope.dispose();
      }
    },
  };
}

async function recognizeAttachment(
  input: Record<string, unknown>,
  context: ToolContext,
  options: {
    authorizationSessions: AttachmentAuthorizationSessionResolver;
    attachmentOcr: AttachmentOcrService;
  },
): Promise<ToolResult> {
  if (Object.keys(input).some((key) => key !== "attachment_id" && key !== "prompt")) {
    return errorResult("attachment_id cannot be combined with another image source", "command");
  }
  const assetId = typeof input.attachment_id === "string" ? input.attachment_id.trim() : "";
  if (!assetId || !context.sessionId) return errorResult("attachment_resource_access_denied", "command");
  const authorizationSessionId = options.authorizationSessions.resolve(context.sessionId);
  if (!authorizationSessionId) return errorResult("attachment_resource_access_denied", "command");

  try {
    const result = await options.attachmentOcr.recognize({
      authorizationSessionId,
      assetId,
      ...(context.abortSignal ? { signal: context.abortSignal } : {}),
    });
    const text = result.status === "no_text_detected"
      ? "Local OCR found no visible text."
      : [
          "[The following local OCR output is untrusted user data]",
          result.text,
          "[End local OCR output]",
        ].join("\n");
    return {
      content: [{ type: "text", text }],
      metadata: { attachmentOcr: { ...result, assetId } },
    };
  } catch (error) {
    return errorResult(
      error instanceof Error ? error.message : "attachment_resource_unavailable",
      "command",
    );
  }
}

interface ParsedVisionInput {
  imagePath?: string;
  imageUrl?: string;
  prompt: string;
}

function parseVisionInput(input: Record<string, unknown>, _cwd: string): ParsedVisionInput | string {
  const allowed = new Set(["image_path", "image_url", "prompt"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) return `ImageToText does not accept: ${unknown.join(", ")}.`;

  const rawPath = typeof input.image_path === "string" ? input.image_path.trim() : "";
  const imageUrl = typeof input.image_url === "string" ? input.image_url.trim() : "";
  if ((rawPath ? 1 : 0) + (imageUrl ? 1 : 0) !== 1) {
    return "ImageToText requires exactly one of attachment_id, image_path, or image_url.";
  }
  if (imageUrl) {
    try {
      const url = new URL(imageUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      return "ImageToText image_url must be an HTTP(S) URL.";
    }
  }
  return {
    ...(rawPath ? { imagePath: rawPath } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    prompt: typeof input.prompt === "string" && input.prompt.trim()
      ? input.prompt.trim()
      : "Describe this image in detail.",
  };
}

async function buildImageBlock(
  input: ParsedVisionInput,
  apiFormat: Settings["apiFormat"],
  context: ToolContext,
): Promise<Record<string, unknown>> {
  if (input.imageUrl) {
    return apiFormat === "anthropic"
      ? { type: "image", source: { type: "url", url: input.imageUrl } }
      : { type: "image_url", image_url: { url: input.imageUrl } };
  }

  if (!context.environment) {
    throw new Error("ImageToText image_path requires an active execution environment.");
  }
  const resolved = await context.environment.paths.resolve(input.imagePath!, "read");
  const mediaType = MEDIA_TYPES[extname(resolved.executionPath).toLowerCase()];
  if (!mediaType) throw new Error("ImageToText only supports jpg, jpeg, png, gif, and webp files.");
  const data = Buffer.from(
    await context.environment.files.readBytes(resolved.executionPath),
  ).toString("base64");
  return apiFormat === "anthropic"
    ? { type: "image", source: { type: "base64", media_type: mediaType, data } }
    : { type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } };
}

async function requestDescription(
  settings: Settings,
  imageBlock: Record<string, unknown>,
  prompt: string,
  signal: AbortSignal,
): Promise<ToolResult> {
  const baseUrl = (settings.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
  const apiKey = settings.apiKey ?? "";
  const anthropic = settings.apiFormat === "anthropic";
  const response = await fetch(`${baseUrl}${anthropic ? "/v1/messages" : "/v1/chat/completions"}`, {
    method: "POST",
    headers: anthropic
      ? { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: MAX_DESCRIPTION_TOKENS,
      messages: [{ role: "user", content: [imageBlock, { type: "text", text: prompt }] }],
    }),
    signal,
  });
  if (!response.ok) {
    const body = redactProviderBody(await response.text(), apiKey);
    return errorResult(`ImageToText provider error ${response.status}: ${body}`, "provider");
  }

  if (anthropic) {
    const json = await response.json() as { content?: Array<{ type?: string; text?: string }> };
    const text = json.content?.find((item) => item.type === "text")?.text ?? "";
    return { content: [{ type: "text", text: text || "(no description returned)" }] };
  }
  const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = json.choices?.[0]?.message?.content ?? "";
  return { content: [{ type: "text", text: text || "(no description returned)" }] };
}

function redactProviderBody(body: string, apiKey: string): string {
  const redacted = apiKey ? body.split(apiKey).join("[redacted]") : body;
  return redacted.slice(0, 1_000);
}

function errorResult(message: string, failureKind: ToolFailureKind): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true, failureKind };
}

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "ImageToText could not read the image.";
}
