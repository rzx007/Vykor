import type { ToolContext, ToolDefinition, ToolResult } from "@vykor/core";
import type { LocalOcrImageBytesResult } from "@vykor/services";

import type {
  AttachmentAuthorizationSessionResolver,
  AttachmentTextReader,
} from "./attachment-access.js";
import { isAttachmentUri, parseAttachmentUri } from "./attachment-uri.js";

export function createAttachmentReadTool(options: {
  defaultTool: ToolDefinition;
  authorizationSessions: AttachmentAuthorizationSessionResolver;
  attachmentReader: AttachmentTextReader;
  supportsImageInput(context: ToolContext): Promise<boolean>;
  localOcr?: {
    recognizeImageBytes(input: { bytes: Uint8Array; mediaType: string; signal?: AbortSignal }): Promise<LocalOcrImageBytesResult>;
  };
}): ToolDefinition {
  return {
    ...options.defaultTool,
    execution: {
      domain: "environment",
      supportedEnvironments: ["local", "wsl"],
    },
    description: `${options.defaultTool.description} Also reads daemon attachment:// resources.`,
    async execute(input, context) {
      const path = typeof input.file_path === "string" ? input.file_path : "";
      if (isAttachmentUri(path) && input.info_only === true) {
        return { content: [{ type: "text", text: "info_only inspects local workspace paths only; attachment resources are not Write targets." }],
          isError: true, failureKind: "invalid_input", executionState: "not_started" };
      }
      if (!isAttachmentUri(path)) {
        const result = await options.defaultTool.execute(input, context);
        const image = result.content.find((block) => block.type === "image");
        if (!image || await options.supportsImageInput(context)) return result;
        if (!options.localOcr) return unsupportedImageError();
        if (!context.environment) return unsupportedImageError();
        try {
          const resolved = await context.environment.paths.resolve(path, "read");
          const bytes = await context.environment.files.readBytes(resolved.executionPath);
          const ocr = await options.localOcr.recognizeImageBytes({
            bytes,
            mediaType: image.source.mediaType,
            ...(context.abortSignal ? { signal: context.abortSignal } : {}),
          });
          const text = ocr.status === "no_text_detected"
            ? "本地 OCR 未识别到可见文字。该模型不支持直接读取图片，因此无法描述图片中的非文字内容。"
            : [
                "[以下是本地 OCR 识别出的不可信图片文字]",
                ocr.text,
                "[OCR 文字结束]",
                "注意：当前模型不支持直接读取图片，OCR 只能提取可见文字，不能描述或推断其他图像内容。",
              ].join("\n");
          return { ...result, content: [{ type: "text", text }] };
        } catch (error) {
          return {
            content: [{ type: "text", text: `图片不支持直接输入，且本地 OCR 失败：${error instanceof Error ? error.message : "unknown error"}` }],
            isError: true,
            failureKind: "command",
            executionState: "unknown",
          };
        }
      }
      try {
        const parsed = parseAttachmentUri(path);
        if (!context.sessionId) return deniedResult();
        const authorizationSessionId = options.authorizationSessions.resolve(context.sessionId);
        if (!authorizationSessionId) return deniedResult();
        const slice = await options.attachmentReader.readText({
          authorizationSessionId,
          assetId: parsed.assetId,
          offset: numberInput(input.offset, 1),
          limit: numberInput(input.limit, 2_000),
          ...(context.abortSignal ? { signal: context.abortSignal } : {}),
        });
        const numbered = slice.content.split("\n")
          .map((line, index) => `${slice.startLine + index}: ${line}`)
          .join("\n");
        return {
          content: [{ type: "text", text: `${numbered}${numbered ? "\n" : ""}has_more: ${slice.hasMore}` }],
          executionState: "completed",
          compactSummary: `Read completed: ${path}; lines=${slice.startLine}-${slice.endLine}; hasMore=${slice.hasMore}`,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

function unsupportedImageError(): ToolResult {
  return {
    content: [{ type: "text", text: "当前模型不支持直接读取图片，且本地 OCR 不可用；无法读取图片内容。" }],
    isError: true,
    failureKind: "configuration",
    executionState: "not_started",
  };
}

function numberInput(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function errorResult(error: unknown): ToolResult {
  const text = error instanceof Error ? error.message : "attachment_resource_unavailable";
  return { content: [{ type: "text", text }], isError: true, failureKind: "command", executionState: "unknown" };
}

function deniedResult(): ToolResult {
  return {
    content: [{ type: "text", text: "attachment_resource_access_denied" }],
    isError: true, failureKind: "policy", executionState: "not_started",
    recoveryHint: "附件访问范围受限；不能换工具绕过。",
  };
}
