import type { ToolDefinition } from "@vykor/core";
import { resolveToolPathInContext } from "./environment-path.js";
import { sandboxPathError } from "./sandbox-guard.js";
import { fileOperationsFor } from "./operations.js";
import { managedPersistencePathKind } from "./managed-persistence-path.js";

// System directories that must never be written to, regardless of permission mode.
const SYSTEM_DIR_PREFIXES = [
  "/etc/", "/sys/", "/proc/", "/dev/", "/boot/",
  "/usr/bin/", "/usr/sbin/", "/bin/", "/sbin/",
  "c:\\windows\\", "c:\\program files\\", "c:\\program files (x86)\\",
];

function isSystemPath(p: string): boolean {
  const normalized = p.replace(/\\/g, "/").toLowerCase();
  return SYSTEM_DIR_PREFIXES.some((prefix) => normalized.startsWith(prefix.replace(/\\/g, "/")));
}

export const fileWriteTool: ToolDefinition = {
  name: "Write",
  description:
    "Write a file to the local filesystem. Will overwrite existing files.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to write to." },
      content: { type: "string", description: "Content to write." },
    },
    required: ["file_path", "content"],
  },
  async execute(input, context) {
    const rawPath = input.file_path as string;
    const content = input.content as string;
    const cwd = (context as { cwd?: string } | undefined)?.cwd ?? process.cwd();

    // Resolve to absolute path, then guard against system directories.
    const filePath = await resolveToolPathInContext(rawPath, context, "write");

    if (managedPersistencePathKind(filePath, cwd)) {
      return {
        content: [{ type: "text", text: "Error: this is a managed persistence path. Use the Remember tool instead." }],
        isError: true,
        failureKind: "policy",
        executionState: "not_started",
      };
    }

    if (isSystemPath(filePath)) {
      return {
        content: [{ type: "text", text: `Error: writing to system directory is not allowed: ${filePath}` }],
        isError: true,
        failureKind: "policy",
        executionState: "not_started",
      };
    }

    try {
      const sandboxError = await sandboxPathError(filePath, cwd, "write", context.settings, context.environment);
      if (sandboxError) {
        return {
          content: [{ type: "text", text: sandboxError }],
          isError: true,
          failureKind: "policy",
          executionState: "not_started",
          recoveryHint: "此路径被写入策略限制；不能换工具绕过。",
        };
      }

      await fileOperationsFor(context).writeText(filePath, content);
      return {
        content: [{ type: "text", text: `Successfully wrote to ${filePath}` }],
        executionState: "completed",
        compactSummary: `Write completed: ${filePath}`,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error writing file: ${error}` }],
        isError: true,
        failureKind: "unknown_outcome",
        executionState: "unknown",
        recoveryHint: "写入可能已部分生效；先检查目标文件实际状态。",
      };
    }
  },
};
