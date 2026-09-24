import type { ToolDefinition } from "@vykor/core";
import { createToolAbortScope } from "../abort.js";
import { defaultWebRuntime } from "./default-runtime.js";
import { formatWebError, webErrorFacts } from "./tool-errors.js";
import type { WebRuntimeLike } from "./types.js";

export function createWebSearchTool(runtime: WebRuntimeLike = defaultWebRuntime): ToolDefinition {
  return {
    name: "WebSearch",
    description: "Search the web and return compact top results with titles, URLs, and snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        maxResults: {
          type: "number",
          description: "Maximum number of results (1-10).",
          default: 5,
        },
        searchUrl: {
          type: "string",
          description: "Optional override for the HTML search endpoint.",
        },
      },
      required: ["query"],
    },
    async execute(input, context) {
      const query = input.query as string;
      const maxResults = (input.maxResults as number) ?? 5;
      const searchUrl = input.searchUrl as string | undefined;
      const abortScope = createToolAbortScope(context.abortSignal, 20_000);

      try {
        const result = await runtime.search(
          { query, maxResults, ...(searchUrl ? { searchUrl } : {}) },
          abortScope.signal,
        );
        if (result.sources.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No search results found for: ${query}\nTry a broader query, alternate terms, or another relevant source.`,
            }],
            executionState: "completed",
            compactSummary: "WebSearch completed: 0 results",
          };
        }

        const lines = [`Search results for: ${query}`];
        for (let index = 0; index < result.sources.length; index++) {
          const source = result.sources[index]!;
          lines.push(`${index + 1}. ${source.title}`);
          lines.push(`   URL: ${source.url}`);
          if (source.snippet) lines.push(`   ${source.snippet}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }], executionState: "completed", compactSummary: `WebSearch completed: ${result.sources.length} results` };
      } catch (error) {
        return {
          content: [{ type: "text", text: formatWebError("web_search", error) }],
          isError: true,
          ...webErrorFacts(error),
        };
      } finally {
        abortScope.dispose();
      }
    },
  };
}

export const webSearchTool: ToolDefinition = createWebSearchTool();
