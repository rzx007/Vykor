import { createHash } from "node:crypto";
import type { ToolDefinition, ToolResult } from "@vykor/core";
import { resolveToolPathInContext } from "./environment-path.js";
import { sandboxPathError } from "./sandbox-guard.js";
import { isFileNotFoundError, fileOperationsFor, fileSnapshotMatches } from "./operations.js";
import { managedPersistencePathKind } from "./managed-persistence-path.js";
import { isSystemPath } from "./file-mutation-guard.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_SUMMARY_LENGTH = 1000;
const SHORT_HASH_LENGTH = 12;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type WriteOperation = "created" | "overwrote" | "unchanged";

function writeSummary(
  operation: WriteOperation,
  filePath: string,
  byteLength: number,
  digest: string,
): string {
  const head = `Write ${operation}: `;
  const tail = ` (${byteLength} bytes, sha256 ${digest.slice(0, SHORT_HASH_LENGTH)})`;
  const budget = MAX_SUMMARY_LENGTH - head.length - tail.length - 1;
  const displayPath = filePath.length <= budget
    ? filePath
    : `…${filePath.slice(-Math.max(0, budget - 1))}`;
  return `${head}${displayPath}${tail}`;
}

function refused(message: string, failureKind: "invalid_input" | "precondition" = "invalid_input", recoveryHint?: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    failureKind,
    executionState: "not_started",
    ...(recoveryHint ? { recoveryHint } : {}),
  };
}

function completed(operation: WriteOperation, filePath: string, content: string): ToolResult {
  const bytes = new TextEncoder().encode(content);
  const digest = sha256(bytes);
  const text = operation === "created"
    ? `Created ${filePath} (${bytes.byteLength} bytes).`
    : operation === "overwrote"
      ? `Overwrote ${filePath} (${bytes.byteLength} bytes).`
      : `No write needed: ${filePath} already has the requested content.`;
  return {
    content: [{ type: "text", text }],
    executionState: "completed",
    compactSummary: writeSummary(operation, filePath, bytes.byteLength, digest),
  };
}

export const fileWriteTool: ToolDefinition = {
  name: "Write",
  serialGroup: "file_mutation",
  description:
    "Create or fully replace a UTF-8 file with the supplied complete content, subject to current permissions and file-state checks. Provide file_path and exactly one of content or content_from. expected_sha256 optionally guards an existing file's raw bytes. content_from reuses a settled Write's retained complete body, including a failed call, but does not reuse its target or permission. Prefer Edit for small changes and ApplyPatch for multi-file or multi-hunk changes.",
  inputReuse: { property: "content", referenceProperty: "content_from" },
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to write to." },
      content: { type: "string", description: "Content to write." },
      content_from: { type: "string", description: "Previous settled Write tool call ID whose complete content to reuse. Do not also pass content. Only works while that content remains in the current conversation history." },
      expected_sha256: {
        type: "string",
        description: "Optional SHA-256 of existing raw bytes for guarded overwrite.",
      },
    },
    required: ["file_path"],
    additionalProperties: false,
  },
  async execute(input, context) {
    if (Object.keys(input).some(key => !["file_path", "content", "expected_sha256"].includes(key))
      || typeof input.file_path !== "string" || Object.hasOwn(input, "content_from") || typeof input.content !== "string") {
      return refused("Write requires resolved string content; content_from must be resolved by the engine.");
    }
    const rawPath = input.file_path as string;
    const content = input.content as string;
    const cwd = (context as { cwd?: string } | undefined)?.cwd ?? process.cwd();
    const expectedSha256Input = input.expected_sha256;
    const expectedSha256 = typeof expectedSha256Input === "string" ? expectedSha256Input : undefined;
    if (
      expectedSha256Input !== undefined &&
      (expectedSha256 === undefined || !SHA256_PATTERN.test(expectedSha256))
    ) {
      return refused("expected_sha256 must be a 64-character hexadecimal SHA-256 value.");
    }

    let writeStarted = false;
    try {
      const filePath = await resolveToolPathInContext(rawPath, context, "write");
      if (managedPersistencePathKind(filePath, cwd)) {
        return {
          content: [{ type: "text", text: "Error: this is a managed persistence path. Use the Remember tool instead." }],
          isError: true,
          failureKind: "policy",
          executionState: "not_started",
        };
      }

      // Guard raw Windows-style paths even when the resolver runs on another platform.
      if (isSystemPath(rawPath) || isSystemPath(filePath)) {
        return {
          content: [{ type: "text", text: `Error: writing to system directory is not allowed: ${filePath}` }],
          isError: true,
          failureKind: "policy",
          executionState: "not_started",
        };
      }

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

      const operations = fileOperationsFor(context);
      let existing: Uint8Array | undefined;
      try {
        const item = await operations.stat(filePath);
        if (!item.isFile || item.isSymbolicLink) return refused(`Cannot write over a non-file path: ${filePath}`, "precondition");
        const readSandboxError = await sandboxPathError(filePath, cwd, "read", context.settings, context.environment);
        if (readSandboxError) {
          return {
            content: [{ type: "text", text: readSandboxError }],
            isError: true,
            failureKind: "policy",
            executionState: "not_started",
          };
        }
        existing = await operations.readBytes(filePath);
      } catch (error) {
        if (!isFileNotFoundError(error)) throw error;
      }

      if (!existing) {
        if (expectedSha256 !== undefined) {
          return refused("expected_sha256 cannot be used when creating a new file.", "precondition");
        }
        writeStarted = true;
        await operations.createTextExclusive(filePath, content);
        return completed("created", filePath, content);
      }

      const requested = new TextEncoder().encode(content);
      if (Buffer.from(existing).equals(Buffer.from(requested))) {
        return completed("unchanged", filePath, content);
      }
      if (expectedSha256 !== undefined && sha256(existing) !== expectedSha256.toLowerCase()) {
        return refused(
          "Write conflict: the existing file no longer matches expected_sha256.",
          "precondition",
          "重新 Read 目标文件确认当前内容，再决定是否覆盖；不要绕过 hash 校验。",
        );
      }
      if (!await fileSnapshotMatches(operations, filePath, existing)) {
        return refused("Write conflict: the file changed after reading it.", "precondition", "重新 Read 当前文件后再决定修改；不要覆盖其他进程的新内容。");
      }
      writeStarted = true;
      await operations.writeTextAtomic(filePath, content);
      return completed("overwrote", filePath, content);
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error writing file: ${error}` }],
        isError: true,
        failureKind: writeStarted ? "unknown_outcome" : "command",
        executionState: writeStarted ? "unknown" : "not_started",
        recoveryHint: writeStarted ? "写入可能已部分生效；先检查目标文件实际状态。" : "本次未开始写入；检查路径、权限和目标当前状态。",
      };
    }
  },
};
