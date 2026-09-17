import type { ToolDefinition, ToolResult } from "@openharness/core";

import type {
  AttachmentAuthorizationSessionResolver,
  AttachmentTextReader,
} from "./attachment-access.js";
import { isAttachmentUri, parseAttachmentUri } from "./attachment-uri.js";

export function createAttachmentReadTool(options: {
  defaultTool: ToolDefinition;
  authorizationSessions: AttachmentAuthorizationSessionResolver;
  attachmentReader: AttachmentTextReader;
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
      if (!isAttachmentUri(path)) return await options.defaultTool.execute(input, context);
      try {
        const parsed = parseAttachmentUri(path);
        if (!context.sessionId) throw new Error("attachment_resource_access_denied");
        const authorizationSessionId = options.authorizationSessions.resolve(context.sessionId);
        if (!authorizationSessionId) throw new Error("attachment_resource_access_denied");
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
        return { content: [{ type: "text", text: `${numbered}${numbered ? "\n" : ""}has_more: ${slice.hasMore}` }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

function numberInput(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function errorResult(error: unknown): ToolResult {
  const text = error instanceof Error ? error.message : "attachment_resource_unavailable";
  return { content: [{ type: "text", text }], isError: true, failureKind: "command" };
}
