import type { ToolDefinition } from "@vykor/core";
import { createToolAbortScope } from "../abort.js";
import { defaultWebRuntime } from "./default-runtime.js";
import { formatWebError, webErrorFacts } from "./tool-errors.js";
import type { WebFetchFormat, WebRuntimeLike } from "./types.js";

export function createWebFetchTool(runtime: WebRuntimeLike = defaultWebRuntime): ToolDefinition {
  return {
    name: "WebFetch",
    description: "Fetch one web page and return compact readable text.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTP or HTTPS URL to fetch." },
        format: {
          type: "string",
          enum: ["text", "markdown", "html"],
          description: "Response format.",
        },
        maxChars: {
          type: "number",
          description: "Maximum characters to return (500-50000). Default: 12000.",
          default: 12000,
        },
      },
      required: ["url"],
    },
    async execute(input, context) {
      const url = input.url as string;
      const maxChars = (input.maxChars as number) ?? 12000;
      const format = (input.format as WebFetchFormat) ?? "text";
      const abortScope = createToolAbortScope(context.abortSignal, 20_000);

      try {
        const result = await runtime.fetch(
          { url, maxChars, format },
          abortScope.signal,
        );
        if (!result.ok) {
          const statusText = result.statusText ? ` ${result.statusText}` : "";
          return {
            content: [{
              type: "text",
              text: `web_fetch failed [http_status]: HTTP ${result.status}${statusText}`,
            }],
            isError: true,
            failureKind: "provider",
            executionState: "completed",
            recoveryHint: result.status === 429 || result.status === 503
              ? "网页服务暂时不可用；稍后检查访问条件再决定是否重试。"
              : "检查网页地址及访问条件；HTTP 状态本身不能区分认证和策略限制。",
          };
        }

        const header = [
          `URL: ${result.url}`,
          `Status: ${result.status}`,
          `Content-Type: ${result.contentType || "(unknown)"}`,
          "",
        ].join("\n");
        return { content: [{ type: "text", text: `${header}\n${result.body}` }], executionState: "completed", compactSummary: `WebFetch completed: HTTP ${result.status}` };
      } catch (error) {
        return {
          content: [{ type: "text", text: formatWebError("web_fetch", error) }],
          isError: true,
          ...webErrorFacts(error),
        };
      } finally {
        abortScope.dispose();
      }
    },
  };
}

export const webFetchTool: ToolDefinition = createWebFetchTool();
