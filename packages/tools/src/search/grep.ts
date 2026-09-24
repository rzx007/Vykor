import type { ToolDefinition } from "@vykor/core";
import { fileOperationsFor } from "../file/operations.js";
import { resolveToolPathInContext } from "../file/environment-path.js";
import { sandboxPathError } from "../file/sandbox-guard.js";

export const grepTool: ToolDefinition = {
  name: "Grep",
  description:
    "Search file contents using regular expressions. Returns matching file:line:content entries.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for." },
      path: { type: "string", description: "Directory or file to search in." },
      include: {
        type: "string",
        description: 'File glob pattern to include (e.g. "*.ts").',
      },
      caseSensitive: {
        type: "boolean",
        description: "Whether the search is case-sensitive. Default: true.",
        default: true,
      },
      limit: {
        type: "number",
        description: "Maximum number of matches. Default: 200.",
        default: 200,
      },
    },
    required: ["pattern"],
  },
  async execute(input, context) {
    const pattern = input.pattern as string;
    const cwd = context.cwd ?? process.cwd();
    const basePath = await resolveToolPathInContext((input.path as string) ?? cwd, context, "read");
    const include = input.include as string | undefined;
    const caseSensitive = (input.caseSensitive as boolean) ?? true;
    const limit = (input.limit as number) ?? 200;

    try {
      const sandboxError = await sandboxPathError(basePath, cwd, "read", context.settings, context.environment);
      if (sandboxError) {
        return {
          content: [{ type: "text", text: sandboxError }],
          isError: true,
        };
      }

      const operations = fileOperationsFor(context);
      const results = await operations.grep(basePath, pattern, {
        include,
        caseSensitive,
        limit,
      });
      return {
        content: [
          {
            type: "text",
            text: results.length > 0 ? results.join("\n") : "(no matches)",
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error}` }],
        isError: true,
      };
    }
  },
};
