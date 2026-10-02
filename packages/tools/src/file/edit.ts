import { createHash } from "node:crypto";
import type { ToolDefinition, ToolResult } from "@vykor/core";
import { resolveToolPathInContext } from "./environment-path.js";
import { sandboxPathError } from "./sandbox-guard.js";
import { fileOperationsFor, fileSnapshotMatches } from "./operations.js";
import { managedPersistencePathKind } from "./managed-persistence-path.js";
import { isSystemPath } from "./file-mutation-guard.js";
import { decodeUtf8Text } from "./text-content.js";
import { EditPlanError, parseTextEdits, planTextEdits } from "./edit-plan.js";
import { editFailureResult } from "./edit-feedback.js";

const replacementProperties = {
  old_string: { type: "string", description: "Copy the shortest unique text observed in the current file, with enough context to identify it. Do not reconstruct unrelated values." },
  new_string: { type: "string", description: "Literal replacement text." },
  replace_all: { type: "boolean", description: "Replace all occurrences." },
};

function refused(text: string, failureKind: "invalid_input" | "policy" = "invalid_input"): ToolResult {
  return { content: [{ type: "text", text }], isError: true, failureKind, executionState: "not_started" };
}

export const fileEditTool: ToolDefinition = {
  name: "Edit",
  serialGroup: "file_mutation",
  description: "Modify one existing UTF-8 text file. Provide either old_string/new_string or an edits array for multiple ordered changes to the same file. All edits are planned before one atomic write; a failed step writes nothing. Use current file context from failure diagnostics to correct old_string. Prefer ApplyPatch for multiple files or hunks.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file." },
      ...replacementProperties,
      edits: { type: "array", description: "Ordered replacements in one file; do not also provide the single-replacement fields.",
        items: { type: "object", properties: replacementProperties, required: ["old_string", "new_string"] } },
      expected_sha256: { type: "string", description: "Optional raw-byte SHA-256 from Read info_only to detect a stale target." },
    },
    required: ["file_path"],
  },
  async execute(input, context) {
    try { parseTextEdits(input); }
    catch (error) { return refused(error instanceof Error ? error.message : "Invalid edit input."); }
    if (typeof input.file_path !== "string" || input.file_path.length === 0) return refused("file_path must be a non-empty string.");
    if (input.expected_sha256 !== undefined && (typeof input.expected_sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(input.expected_sha256))) {
      return refused("expected_sha256 must be a 64-character hexadecimal SHA-256 value.");
    }
    const rawPath = input.file_path;
    const cwd = context.cwd ?? process.cwd();
    let writeStarted = false;
    try {
      const filePath = await resolveToolPathInContext(rawPath, context, "write");
      if (managedPersistencePathKind(filePath, cwd)) return refused("Error: this is a managed persistence path. Use the Remember tool instead.", "policy");
      if (isSystemPath(rawPath) || isSystemPath(filePath)) return refused(`Error: editing system directory files is not allowed: ${filePath}`, "policy");
      for (const operation of ["read", "write"] as const) {
        const denied = await sandboxPathError(filePath, cwd, operation, context.settings, context.environment);
        if (denied) return refused(denied, "policy");
      }
      const operations = fileOperationsFor(context);
      const item = await operations.stat(filePath);
      if (!item.isFile || item.isSymbolicLink) return refused("Edit requires a regular file, not a directory or symbolic link.");
      const beforeBytes = await operations.readBytes(filePath);
      if (typeof input.expected_sha256 === "string" && createHash("sha256").update(beforeBytes).digest("hex") !== input.expected_sha256.toLowerCase()) {
        return refused("Edit conflict: the existing file no longer matches expected_sha256. Read the current file again.");
      }
      let original: string;
      try { original = decodeUtf8Text(beforeBytes); }
      catch { return refused("Edit requires valid UTF-8 text; binary or invalid content was not modified."); }
      let plan: ReturnType<typeof planTextEdits>;
      try { plan = planTextEdits(original, input); }
      catch (error) {
        if (error instanceof EditPlanError) return editFailureResult(error, original);
        throw error;
      }
      if (!await fileSnapshotMatches(operations, filePath, beforeBytes)) return refused("Edit conflict: the file changed after reading it. Read its current state before trying again.");
      writeStarted = true;
      await operations.writeTextAtomic(filePath, plan.content);
      return {
        content: [{ type: "text", text: `Successfully edited ${filePath}${plan.editCount > 1 ? ` (${plan.editCount} edits)` : ""}` }],
        executionState: "completed", compactSummary: `Edit completed: ${filePath}; edits=${plan.editCount}`,
        metadata: { editCount: plan.editCount },
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error editing file: ${error}` }], isError: true,
        failureKind: writeStarted ? "unknown_outcome" : "command",
        executionState: writeStarted ? "unknown" : "not_started",
        recoveryHint: writeStarted ? "编辑可能已部分生效；先检查目标文件实际状态。" : "本次没有写入；检查文件路径、权限和实际状态。",
      };
    }
  },
};
