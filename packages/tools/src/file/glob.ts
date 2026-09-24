import type { ToolDefinition } from "@vykor/core";
import { resolveToolPathInContext } from "./environment-path.js";
import { sandboxPathError } from "./sandbox-guard.js";
import { fileOperationsFor } from "./operations.js";

const DEFAULT_LIMIT = 200;

export const globTool: ToolDefinition = {
  name: "Glob",
  description:
    "Fast file pattern matching tool. Supports glob patterns like **/*.ts.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: 'Glob pattern (e.g. "**/*.ts").' },
      path: { type: "string", description: "Directory to search in." },
      limit: {
        type: "number",
        description: "Maximum number of files to return. Default: 200.",
        default: DEFAULT_LIMIT,
      },
    },
    required: ["pattern"],
  },
  async execute(input, context) {
    const pattern = input.pattern as string;
    const cwd = context.cwd ?? process.cwd();
    const basePath = await resolveToolPathInContext((input.path as string) ?? cwd, context, "read");
    const limit = (input.limit as number) ?? DEFAULT_LIMIT;

    try {
      const sandboxError = await sandboxPathError(basePath, cwd, "read", context.settings, context.environment);
      if (sandboxError) {
        return {
          content: [{ type: "text" as const, text: sandboxError }],
          isError: true,
        };
      }

      const operations = fileOperationsFor(context);
      const files = await operations.glob(basePath, pattern, limit);
      const sorted = files.sort().slice(0, limit);

      return {
        content: [
          {
            type: "text" as const,
            text: sorted.length > 0 ? sorted.join("\n") : "No files matched.",
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error}` }],
        isError: true,
      };
    }
  },
};
