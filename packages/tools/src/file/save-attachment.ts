import type { ToolContext, ToolDefinition, ToolFailureKind, ToolResult } from "@vykor/agent-contracts";
import type { FileToolHost } from "../ports/policy.js";
import { resolveToolPathInContext } from "./access/environment-path.js";
import { isSystemPath } from "./access/file-mutation-guard.js";
import { managedPersistencePathKind } from "./access/managed-persistence-path.js";
import { sandboxPathError } from "./access/sandbox-guard.js";
import { targetProjectInstructions } from "./instructions.js";
import { withFileMutationLock } from "./mutation-lock.js";
import { fileOperationsFor } from "./operations.js";
import { fileDigest, hostFileFacts } from "./read.js";

function refused(text: string, failureKind: ToolFailureKind = "invalid_input"): ToolResult {
  return { content: [{ type: "text", text }], isError: true, failureKind, executionState: "not_started" };
}

export function createSaveAttachmentTool(host: FileToolHost & {
  /** Host validates session ownership, source state and original byte integrity on every call. */
  readAttachment(uri: string, context: ToolContext): Promise<Uint8Array>;
}): ToolDefinition {
  return {
    name: "SaveAttachment",
    serialGroup: "file_mutation",
    execution: { domain: "control_plane", supportedEnvironments: ["local", "wsl"] },
    description: "Save or export an authorized conversation attachment to a file in the current execution environment. Provide attachment_uri (attachment://...) and file_path. Copies original bytes for images, documents, archives and other files without interpreting or executing them. Use this before local image processing, document editing or embedding an attachment in a project. Existing targets are never overwritten; choose a new path. Does not require a visual model, OCR or an image-generation service.",
    inputSchema: {
      type: "object",
      properties: {
        attachment_uri: { type: "string", description: "Authorized attachment:// resource from this conversation." },
        file_path: { type: "string", description: "Destination path in the active execution environment, absolute or relative to the working directory." },
      },
      required: ["attachment_uri", "file_path"],
      additionalProperties: false,
    },
    async execute(input, context) {
      if (Object.keys(input).some(key => key !== "attachment_uri" && key !== "file_path") ||
          typeof input.attachment_uri !== "string" || !input.attachment_uri.trim() ||
          typeof input.file_path !== "string" || !input.file_path.trim()) {
        return refused("SaveAttachment requires attachment_uri and file_path strings only.");
      }
      let writeStarted = false;
      try {
        context.abortSignal?.throwIfAborted();
        const filePath = await resolveToolPathInContext(input.file_path, context, "write");
        const hostPath = context.environment?.paths.toHostPath?.(filePath);
        const files = fileOperationsFor(context);
        return await withFileMutationLock(files, [filePath], context, async () => {
          if (isSystemPath(input.file_path as string) || isSystemPath(filePath) || (hostPath && isSystemPath(hostPath)))
            return refused("Writing to a system directory is not allowed.", "policy");
          if (managedPersistencePathKind(filePath, context.cwd) ||
              (hostPath && managedPersistencePathKind(hostPath, context.environment!.workspace.hostRoot)))
            return refused("This is a managed persistence path. Use Remember instead.", "policy");
          const sandboxError = await sandboxPathError(filePath, context.cwd, "write", host.settings, context.environment);
          if (sandboxError) return refused(sandboxError, "policy");
          const instructions = await targetProjectInstructions([filePath], context, host, true);
          if (instructions) return instructions;
          if (!files.createBytesExclusive)
            return refused("This execution environment cannot safely create binary files without overwriting existing targets.", "policy");
          let bytes: Uint8Array;
          try {
            bytes = await host.readAttachment(input.attachment_uri as string, context);
          } catch {
            // Source errors may include private host paths; only the destination is public.
            return refused("Attachment could not be read. Verify this conversation still owns a ready, intact attachment.", "command");
          }
          context.abortSignal?.throwIfAborted();
          const digest = fileDigest(bytes);
          writeStarted = true;
          await files.createBytesExclusive(filePath, bytes);
          return {
            content: [{ type: "text", text: `Saved attachment to ${filePath} (${bytes.byteLength} bytes, ${digest}).` }],
            executionState: "completed",
            metadata: { hostFileFacts: hostFileFacts(context, [{ path: filePath, operation: "write", beforeDigest: "missing", afterDigest: digest }]) },
            compactSummary: `Saved attachment: ${filePath} (${bytes.byteLength} bytes, ${digest})`,
          };
        });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST")
          return refused("Destination already exists. Choose a new file_path; SaveAttachment never overwrites files.", "precondition");
        return {
          content: [{ type: "text", text: writeStarted
            ? "Saving failed after writing started. Check the destination before retrying."
            : "Attachment was not saved. Check destination permissions, cancellation and current file state." }],
          isError: true,
          failureKind: writeStarted ? "unknown_outcome" : "command",
          executionState: writeStarted ? "unknown" : "not_started",
        };
      }
    },
  };
}
