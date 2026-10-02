import type { ToolDefinition } from "@vykor/core";
import { fileOperationsFor } from "../file/operations.js";
import { resolveToolPathInContext } from "../file/environment-path.js";
import { sandboxPathError } from "../file/sandbox-guard.js";

export const grepTool: ToolDefinition = {
  name: "Grep",
  description:
    "Search file contents using regular expressions. For Shell logs use path=shell-output://UUID; byte positions can be opened with Read cursor.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for." },
      path: { type: "string", description: "Directory, file, or shell-output://UUID from Shell." },
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
    if (typeof input.path === "string" && /^shell-output:/i.test(input.path)) {
      const invalid = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true, failureKind: "invalid_input" as const, executionState: "not_started" as const });
      if (input.include !== undefined) return invalid("Remove include when searching a Shell output reference.");
      if (!context.shellOutputLogs || !context.sessionId) return {
        content: [{ type: "text", text: "Shell output reference unavailable in this session." }],
        isError: true, failureKind: "configuration", executionState: "not_started",
      };
      const requested = input.limit;
      const limit = typeof requested === "number" && Number.isSafeInteger(requested) && requested > 0 ? Math.min(200, requested) : 200;
      const found = await context.shellOutputLogs.search({ sessionId: context.sessionId, reference: input.path, pattern, caseSensitive: input.caseSensitive !== false, signal: context.abortSignal });
      if (found.status !== "ok" && found.status !== "limit") {
        const reasons = { unavailable: "Shell output reference unavailable in this session.", invalid_pattern: "Invalid regular expression.", timeout: "Shell output search timed out.", search_unavailable: "Shell output search could not run." };
        return {
          content: [{ type: "text", text: reasons[found.status] }],
          isError: true,
          failureKind: found.status === "invalid_pattern" ? "invalid_input" : found.status === "timeout"
            ? context.abortSignal?.aborted ? "interrupted" : "timeout" : "unknown_outcome",
          executionState: "unknown",
          recoveryHint: `Use Read(file_path="${input.path}", cursor=0) to inspect retained output.`,
        };
      }
      const matches = found.matches.slice(0, limit);
      const firstOffset = matches[0]?.byteOffset ?? 0;
      const hint = `Results limited. Use Read(file_path="${input.path}", cursor=${firstOffset}) for context.`;
      const bodyBudget = 8192 - Buffer.byteLength(hint, "utf8");
      let body = "";
      let bytes = 0;
      let shown = 0;
      let shortened = false;
      for (const match of matches) {
        const prefix = `${match.byteOffset}: `;
        const available = bodyBudget - bytes - Buffer.byteLength(prefix, "utf8") - 4; // newline and ellipsis
        if (available < 0) break;
        let snippet = "";
        let snippetBytes = 0;
        for (const { segment: character } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(match.text)) {
          const size = Buffer.byteLength(character, "utf8");
          if (snippetBytes + size > available) break;
          snippet += character;
          snippetBytes += size;
        }
        shortened = snippet.length < match.text.length;
        const line = `${prefix}${snippet}${shortened ? "…" : ""}\n`;
        body += line;
        bytes += Buffer.byteLength(line, "utf8");
        shown++;
        if (shortened) break;
      }
      const truncated = found.truncated || found.matches.length > limit || shown < matches.length || shortened;
      const output = body || (truncated ? "Search limited before a match location could be reported.\n" : "(no matches)\n");
      return { content: [{ type: "text", text: output + (truncated ? hint : "") }], executionState: "completed" };
    }
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
