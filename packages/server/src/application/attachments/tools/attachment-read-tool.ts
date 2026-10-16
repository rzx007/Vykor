import type { ToolContext, ToolDefinition, ToolResult } from "@vykor/core";
import type { LocalOcrImageBytesResult } from "@vykor/services";
import { readOfficeBytes, MAX_OFFICE_BYTES } from "@vykor/services";
import { officeFormat } from "@vykor/protocol";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import type {
  AttachmentAuthorizationSessionResolver,
  AttachmentTextReader,
} from "./attachment-access.js";
import { isAttachmentUri, parseAttachmentUri } from "./attachment-uri.js";
import { officeTextLines } from "./attachment-access.js";

export function createAttachmentReadTool(options: {
  defaultTool: ToolDefinition;
  authorizationSessions: AttachmentAuthorizationSessionResolver;
  attachmentReader: AttachmentTextReader;
  supportsImageInput(context: ToolContext): Promise<boolean>;
  localOcr?: {
    recognizeImageBytes(input: {
      bytes: Uint8Array;
      mediaType: string;
      signal?: AbortSignal;
    }): Promise<LocalOcrImageBytesResult>;
  };
}): ToolDefinition {
  return {
    ...options.defaultTool,
    execution: {
      domain: "environment",
      supportedEnvironments: ["local", "wsl"],
    },
    description: `${options.defaultTool.description} Also reads authorized attachment:// resources and extracts .docx/.xlsx/.pptx as plain text; long Office paragraphs wrap into display lines of up to 2000 characters. Use offset/limit to continue through these lines. Office originals are not modified.`,
    async execute(input, context) {
      const path = typeof input.file_path === "string" ? input.file_path : "";
      if (isAttachmentUri(path) && input.info_only === true) {
        return {
          content: [
            {
              type: "text",
              text: "info_only inspects local workspace paths only; attachment resources are not Write targets.",
            },
          ],
          isError: true,
          failureKind: "invalid_input",
          executionState: "not_started",
        };
      }
      if (!isAttachmentUri(path)) {
        if (officeFormat(path) && input.info_only !== true) {
          // Reuse Read's existing path and sandbox checks before opening Office bytes.
          const inspected = await options.defaultTool.execute(
            { file_path: path, info_only: true },
            context,
          );
          if (inspected.isError) return inspected;
          try {
            const block = inspected.content.find((b) => b.type === "text");
            if (!block || block.type !== "text")
              throw new Error("无法检查 Office 文件。");
            const info = JSON.parse(block.text) as {
              path: string;
              kind: string;
              sizeBytes: number;
              sha256: string;
            };
            if (
              (info.kind !== "file" && info.kind !== "symlink") ||
              !Number.isSafeInteger(info.sizeBytes) || info.sizeBytes < 0 ||
              info.sizeBytes > MAX_OFFICE_BYTES || typeof info.sha256 !== "string"
            )
              throw new Error("Office 文件不存在或超过 64 MB。");
            const bytes = context.environment
              ? await context.environment.files.readBytes(info.path)
              : await readFile(info.path);
            if (
              createHash("sha256").update(bytes).digest("hex") !== info.sha256
            )
              throw new Error("文件在读取期间发生变化，请重试。");
            const result = await readOfficeBytes(bytes, path, {
              signal: context.abortSignal,
            });
            const lines = officeTextLines(result.text),
              offset = numberInput(input.offset, 1),
              limit = numberInput(input.limit, 2000);
            if (
              !Number.isSafeInteger(offset) ||
              offset < 1 ||
              !Number.isSafeInteger(limit) ||
              limit < 1 ||
              limit > 2000
            )
              throw new Error("offset/limit 无效。");
            const selected: string[] = [];
            let chars = 0;
            for (const line of lines.slice(offset - 1, offset - 1 + limit)) {
              if (chars + Buffer.byteLength(line, "utf8") > 48000) break;
              selected.push(line);
              chars += Buffer.byteLength(line, "utf8") + 20;
            }
            return {
              ...inspected,
              content: [
                {
                  type: "text",
                  text:
                    selected
                      .map((line, i) => `${offset + i}: ${line}`)
                      .join("\n") +
                    `\nhas_more: ${offset - 1 + selected.length < lines.length}`,
                },
              ],
              compactSummary: `Read Office: ${path}`,
              executionState: "completed",
            };
          } catch (error) {
            return errorResult(error);
          }
        }
        const result = await options.defaultTool.execute(input, context);
        const image = result.content.find((block) => block.type === "image");
        if (!image || (await options.supportsImageInput(context)))
          return result;
        if (!options.localOcr) return unsupportedImageError();
        if (!context.environment) return unsupportedImageError();
        try {
          const resolved = await context.environment.paths.resolve(
            path,
            "read",
          );
          const bytes = await context.environment.files.readBytes(
            resolved.executionPath,
          );
          const ocr = await options.localOcr.recognizeImageBytes({
            bytes,
            mediaType: image.source.mediaType,
            ...(context.abortSignal ? { signal: context.abortSignal } : {}),
          });
          const text =
            ocr.status === "no_text_detected"
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
            content: [
              {
                type: "text",
                text: `图片不支持直接输入，且本地 OCR 失败：${error instanceof Error ? error.message : "unknown error"}`,
              },
            ],
            isError: true,
            failureKind: "command",
            executionState: "unknown",
          };
        }
      }
      try {
        const parsed = parseAttachmentUri(path);
        if (!context.sessionId) return deniedResult();
        const authorizationSessionId = options.authorizationSessions.resolve(
          context.sessionId,
        );
        if (!authorizationSessionId) return deniedResult();
        const slice = await options.attachmentReader.readText({
          authorizationSessionId,
          assetId: parsed.assetId,
          offset: numberInput(input.offset, 1),
          limit: numberInput(input.limit, 2_000),
          ...(context.abortSignal ? { signal: context.abortSignal } : {}),
        });
        const numbered = slice.content
          .split("\n")
          .map((line, index) => `${slice.startLine + index}: ${line}`)
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: `${numbered}${numbered ? "\n" : ""}has_more: ${slice.hasMore}`,
            },
          ],
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
    content: [
      {
        type: "text",
        text: "当前模型不支持直接读取图片，且本地 OCR 不可用；无法读取图片内容。",
      },
    ],
    isError: true,
    failureKind: "configuration",
    executionState: "not_started",
  };
}

function numberInput(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function errorResult(error: unknown): ToolResult {
  const text =
    error instanceof Error ? error.message : "attachment_resource_unavailable";
  return {
    content: [{ type: "text", text }],
    isError: true,
    failureKind: "command",
    executionState: "unknown",
  };
}

function deniedResult(): ToolResult {
  return {
    content: [{ type: "text", text: "attachment_resource_access_denied" }],
    isError: true,
    failureKind: "policy",
    executionState: "not_started",
    recoveryHint: "附件访问范围受限；不能换工具绕过。",
  };
}
