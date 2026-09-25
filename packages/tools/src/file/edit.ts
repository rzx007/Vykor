import type { ToolDefinition } from "@vykor/core";
import { resolveToolPathInContext } from "./environment-path.js";
import { sandboxPathError } from "./sandbox-guard.js";
import { fileOperationsFor } from "./operations.js";
import { managedPersistencePathKind } from "./managed-persistence-path.js";
import {
  EditMatchError,
  convertToLineEnding,
  detectLineEnding,
  editMatchMessage,
  normalizeLineEndings,
  replace as replaceFuzzy,
} from "./edit-replacers.js";

// System directories that must never be edited, regardless of permission mode.
const SYSTEM_DIR_PREFIXES = [
  "/etc/", "/sys/", "/proc/", "/dev/", "/boot/",
  "/usr/bin/", "/usr/sbin/", "/bin/", "/sbin/",
  "c:\\windows\\", "c:\\program files\\", "c:\\program files (x86)\\",
];

function isSystemPath(p: string): boolean {
  const normalized = p.replace(/\\/g, "/").toLowerCase();
  return SYSTEM_DIR_PREFIXES.some((prefix) => normalized.startsWith(prefix.replace(/\\/g, "/")));
}

export const fileEditTool: ToolDefinition = {
  name: "Edit",
  description:
    "Perform exact string replacements in files.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file." },
      old_string: { type: "string", description: "Text to replace." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace all occurrences." },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  async execute(input, context) {
    const rawPath = input.file_path as string;
    const oldString = input.old_string as string;
    const newString = input.new_string as string;
    const replaceAll = (input.replace_all as boolean) ?? false;
    const cwd = (context as { cwd?: string } | undefined)?.cwd ?? process.cwd();

    if (!oldString) {
      return {
        content: [{ type: "text", text: "old_string must not be empty." }],
        isError: true,
        failureKind: "invalid_input",
        executionState: "not_started",
      };
    }

    const filePath = await resolveToolPathInContext(rawPath, context, "write");

    if (managedPersistencePathKind(filePath, cwd)) {
      return {
        content: [{ type: "text", text: "Error: this is a managed persistence path. Use the Remember tool instead." }],
        isError: true,
        failureKind: "policy",
        executionState: "not_started",
      };
    }

    if (isSystemPath(rawPath) || isSystemPath(filePath)) {
      return {
        content: [{ type: "text", text: `Error: editing system directory files is not allowed: ${filePath}` }],
        isError: true,
        failureKind: "policy",
        executionState: "not_started",
      };
    }

    try {
      const readSandboxError = await sandboxPathError(filePath, cwd, "read", context.settings, context.environment);
      if (readSandboxError) {
        return {
          content: [{ type: "text", text: readSandboxError }],
          isError: true,
          failureKind: "policy",
          executionState: "not_started",
        };
      }
      const writeSandboxError = await sandboxPathError(filePath, cwd, "write", context.settings, context.environment);
      if (writeSandboxError) {
        return {
          content: [{ type: "text", text: writeSandboxError }],
          isError: true,
          failureKind: "policy",
          executionState: "not_started",
        };
      }

      if (oldString === newString) {
        return {
          content: [{ type: "text", text: editMatchMessage("identical") }],
          isError: true,
          failureKind: "invalid_input",
          executionState: "not_started",
        };
      }

      const operations = fileOperationsFor(context);
      const content = await operations.readText(filePath);

      const hasBom = content.startsWith("\uFEFF");
      const body = hasBom ? content.slice(1) : content;
      const desiredOld = oldString.startsWith("\uFEFF") ? oldString.slice(1) : oldString;
      const desiredNew = newString.startsWith("\uFEFF") ? newString.slice(1) : newString;

      if (desiredOld.length === 0) {
        return {
          content: [{ type: "text", text: "old_string must not be empty." }],
          isError: true,
          failureKind: "invalid_input",
          executionState: "not_started",
        };
      }

      let updated: string;
      if (body.includes(desiredOld)) {
        const occurrences = body.split(desiredOld).length - 1;
        if (occurrences > 1 && !replaceAll) {
          const lines = findMatchLines(body, desiredOld);
          return {
            content: [
              {
                type: "text",
                text: `Found ${occurrences} matches at lines ${lines.join(", ")}. Make old_string more specific or use replace_all to replace all.`,
              },
            ],
            isError: true,
            failureKind: "invalid_input",
            executionState: "not_started",
            recoveryHint: `匹配位于第 ${lines.join(", ")} 行；请缩小匹配范围或明确 replace_all。`,
          };
        }
        updated = replaceAll
          ? body.replaceAll(desiredOld, desiredNew)
          : body.replace(desiredOld, desiredNew);
      } else {
        const ending = detectLineEnding(body);
        const normalizedOld = convertToLineEnding(normalizeLineEndings(desiredOld), ending);
        const normalizedNew = convertToLineEnding(normalizeLineEndings(desiredNew), ending);
        try {
          updated = replaceFuzzy(body, normalizedOld, normalizedNew, replaceAll);
        } catch (error) {
          if (error instanceof EditMatchError) {
            return {
              content: [{ type: "text", text: editMatchMessage(error.kind) }],
              isError: true,
              failureKind: "invalid_input",
              executionState: "not_started",
            };
          }
          throw error;
        }
      }

      await operations.writeText(filePath, (hasBom ? "\uFEFF" : "") + updated);

      return {
        content: [{ type: "text", text: `Successfully edited ${filePath}` }],
        executionState: "completed",
        compactSummary: `Edit completed: ${filePath}`,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error editing file: ${error}` }],
        isError: true,
        failureKind: "unknown_outcome",
        executionState: "unknown",
        recoveryHint: "编辑可能已部分生效；先检查目标文件实际状态。",
      };
    }
  },
};

function findMatchLines(content: string, needle: string): number[] {
  const lines: number[] = [];
  let currentLine = 1;
  let scanOffset = 0;
  let matchOffset = content.indexOf(needle, scanOffset);

  while (matchOffset >= 0) {
    for (let index = scanOffset; index < matchOffset; index += 1) {
      if (content.charCodeAt(index) === 10) currentLine += 1;
    }
    lines.push(currentLine);
    const matchEnd = matchOffset + needle.length;
    for (let index = matchOffset; index < matchEnd; index += 1) {
      if (content.charCodeAt(index) === 10) currentLine += 1;
    }
    scanOffset = matchEnd;
    matchOffset = content.indexOf(needle, scanOffset);
  }

  return lines;
}
