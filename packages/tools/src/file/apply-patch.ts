import { createHash } from "node:crypto";
import { applyPatch as applyParsedPatch, parsePatch, type ParsedDiff } from "diff";
import type { ToolContext, ToolDefinition, ToolResult } from "@vykor/core";
import type { EnvironmentPathOperation } from "@vykor/environment";
import { resolveToolPathInContext } from "./environment-path.js";
import { sandboxPathError } from "./sandbox-guard.js";
import { isSystemPath } from "./file-mutation-guard.js";
import { managedPersistencePathKind } from "./managed-persistence-path.js";
import { FileNotFoundError, fileOperationsFor, type FileOperations } from "./operations.js";
import {
  isDevNullPath,
  normalizePatchPath,
  patchPathIdentity,
  type PatchPathStyle,
} from "./patch-path.js";
import { convertToLineEnding, detectLineEnding, normalizeLineEndings } from "./edit-replacers.js";
import { decodeUtf8Text, isBinaryContent } from "./text-content.js";

export type PatchFailureKind = "invalid_input" | "policy";

/** ApplyPatch 内部的失败类型，避免靠 message 猜测错误种类。 */
export class PatchToolError extends Error {
  constructor(
    readonly kind: PatchFailureKind,
    message: string,
    readonly recoveryHint?: string,
  ) {
    super(message);
    this.name = "PatchToolError";
  }
}

export type PatchOperation = "create" | "update" | "delete";

export interface PatchChange {
  operation: PatchOperation;
  relativePath: string;
  executionPath: string;
  /** 仅 update/delete：预演时读到的原始字节与其 SHA-256。 */
  beforeBytes?: Uint8Array;
  beforeHash?: string;
  newContent: string;
}

export interface PatchPlan {
  changes: PatchChange[];
}

const UNSUPPORTED_MARKERS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^GIT binary patch$/m, label: "GIT binary patch" },
  { pattern: /^Binary files .* differ$/m, label: "Binary files" },
  { pattern: /^rename from /m, label: "rename from" },
  { pattern: /^rename to /m, label: "rename to" },
  { pattern: /^copy from /m, label: "copy from" },
  { pattern: /^copy to /m, label: "copy to" },
  { pattern: /^old mode /m, label: "old mode" },
  { pattern: /^new mode /m, label: "new mode" },
  { pattern: /^new file mode /m, label: "new file mode" },
  { pattern: /^deleted file mode /m, label: "deleted file mode" },
];

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pathStyle(context: ToolContext): PatchPathStyle {
  return context.environment?.info.pathStyle ?? (process.platform === "win32" ? "windows" : "posix");
}

interface ClassifiedFile {
  operation: PatchOperation;
  relativePath: string;
  file: ParsedDiff;
}

function classifyFile(file: ParsedDiff, style: PatchPathStyle): ClassifiedFile {
  if (file.hunks.length === 0) {
    throw new PatchToolError("invalid_input", "Each patched file must contain at least one hunk.");
  }
  const oldName = file.oldFileName;
  const newName = file.newFileName;
  if (oldName === undefined || newName === undefined) {
    throw new PatchToolError("invalid_input", "Patch file section is missing an old or new file name.");
  }

  const oldIsNull = isDevNullPath(oldName);
  const newIsNull = isDevNullPath(newName);
  if (oldIsNull && newIsNull) {
    throw new PatchToolError("invalid_input", "A patch cannot use /dev/null for both sides.");
  }
  if (oldIsNull) {
    return { operation: "create", relativePath: normalizePatchPath(newName, style), file };
  }
  if (newIsNull) {
    return { operation: "delete", relativePath: normalizePatchPath(oldName, style), file };
  }

  const oldPath = normalizePatchPath(oldName, style);
  const newPath = normalizePatchPath(newName, style);
  if (patchPathIdentity(oldPath, style) !== patchPathIdentity(newPath, style)) {
    throw new PatchToolError("invalid_input", `Rename is not supported: ${oldName} -> ${newName}`);
  }
  return { operation: "update", relativePath: newPath, file };
}

function applyOne(body: string, file: ParsedDiff, label: string): string {
  const result = applyParsedPatch(body, file, { fuzzFactor: 0 });
  if (result === false) {
    throw new PatchToolError("invalid_input", `Patch context does not match the current content: ${label}`);
  }
  return result;
}

async function statExists(operations: FileOperations, executionPath: string): Promise<boolean> {
  try {
    await operations.stat(executionPath);
    return true;
  } catch (error) {
    if (error instanceof FileNotFoundError) return false;
    throw error;
  }
}

async function readExisting(
  operations: FileOperations,
  executionPath: string,
  label: string,
): Promise<Uint8Array> {
  let item: Awaited<ReturnType<FileOperations["stat"]>>;
  try {
    item = await operations.stat(executionPath);
  } catch (error) {
    if (error instanceof FileNotFoundError) {
      throw new PatchToolError("invalid_input", `Patch target does not exist: ${label}`);
    }
    throw error;
  }
  if (!item.isFile || item.isSymbolicLink) {
    throw new PatchToolError("invalid_input", `Patch target is not a regular file: ${label}`);
  }
  return operations.readBytes(executionPath);
}

function decodeOrThrow(bytes: Uint8Array, label: string): string {
  try {
    return decodeUtf8Text(bytes);
  } catch {
    throw new PatchToolError("invalid_input", `Patch target is not valid UTF-8 text: ${label}`);
  }
}

function validateNewContent(content: string, label: string): string {
  if (isBinaryContent(content)) {
    throw new PatchToolError("invalid_input", `Patch would produce binary content: ${label}`);
  }
  return content;
}

interface PlanDependencies {
  context: ToolContext;
  operations: FileOperations;
  cwd: string;
}

async function planChange(item: ClassifiedFile, deps: PlanDependencies): Promise<PatchChange> {
  const { context, operations, cwd } = deps;
  const resolveOperation: EnvironmentPathOperation = item.operation === "create" ? "write" : "read";
  const executionPath = await resolveToolPathInContext(item.relativePath, context, resolveOperation);

  if (managedPersistencePathKind(executionPath, cwd)) {
    throw new PatchToolError("policy", `Patch targets a managed persistence path: ${executionPath}`);
  }
  if (isSystemPath(item.relativePath) || isSystemPath(executionPath)) {
    throw new PatchToolError("policy", `Patch targets a system path: ${executionPath}`);
  }
  const operationsToCheck: Array<"read" | "write"> =
    item.operation === "create" ? ["write"] : ["read", "write"];
  for (const operation of operationsToCheck) {
    const sandboxError = await sandboxPathError(executionPath, cwd, operation, context.settings, context.environment);
    if (sandboxError) throw new PatchToolError("policy", sandboxError);
  }

  if (item.operation === "create") {
    if (await statExists(operations, executionPath)) {
      throw new PatchToolError("invalid_input", `Cannot create a file that already exists: ${item.relativePath}`);
    }
    return {
      operation: "create",
      relativePath: item.relativePath,
      executionPath,
      newContent: validateNewContent(applyOne("", item.file, item.relativePath), item.relativePath),
    };
  }

  const beforeBytes = await readExisting(operations, executionPath, item.relativePath);
  const decoded = decodeOrThrow(beforeBytes, item.relativePath);
  const hasBom = decoded.startsWith("\uFEFF");
  const body = hasBom ? decoded.slice(1) : decoded;
  const ending = detectLineEnding(body);
  const applied = applyOne(normalizeLineEndings(body), item.file, item.relativePath);
  if (item.operation === "delete" && applied !== "") {
    throw new PatchToolError("invalid_input", `Delete patch did not empty the file: ${item.relativePath}`);
  }
  const converted = convertToLineEnding(applied, ending);
  return {
    operation: item.operation,
    relativePath: item.relativePath,
    executionPath,
    beforeBytes,
    beforeHash: sha256(beforeBytes),
    newContent: validateNewContent(hasBom ? "\uFEFF" + converted : converted, item.relativePath),
  };
}

export async function planPatch(patch: string, context: ToolContext): Promise<PatchPlan> {
  if (typeof patch !== "string") {
    throw new PatchToolError("invalid_input", "patch must be a string.");
  }
  if (Buffer.from(patch, "utf8").toString("utf8") !== patch) {
    throw new PatchToolError("invalid_input", "Patch contains text that cannot be encoded as UTF-8 without replacement.");
  }
  for (const { pattern, label } of UNSUPPORTED_MARKERS) {
    if (pattern.test(patch)) {
      throw new PatchToolError("invalid_input", `Unsupported patch marker: ${label}.`);
    }
  }

  let parsed: ParsedDiff[];
  try {
    parsed = parsePatch(normalizeLineEndings(patch));
  } catch (error) {
    throw new PatchToolError("invalid_input", `Cannot parse patch: ${error}`);
  }
  if (parsed.length === 0) {
    throw new PatchToolError("invalid_input", "Patch contains no file sections.");
  }

  const style = pathStyle(context);
  const cwd = context.cwd ?? process.cwd();
  const operations = fileOperationsFor(context);
  let classified: ClassifiedFile[];
  try {
    classified = parsed.map((file) => classifyFile(file, style));
  } catch (error) {
    if (error instanceof PatchToolError) throw error;
    throw new PatchToolError("invalid_input", `Invalid patch path: ${error}`);
  }

  const seen = new Set<string>();
  for (const item of classified) {
    const identity = patchPathIdentity(item.relativePath, style);
    if (seen.has(identity)) {
      throw new PatchToolError("invalid_input", `Patch targets the same path more than once: ${item.relativePath}`);
    }
    seen.add(identity);
  }

  const changes: PatchChange[] = [];
  for (const item of classified) {
    changes.push(await planChange(item, { context, operations, cwd }));
  }
  return { changes };
}

const MAX_SUMMARY_LENGTH = 1000;

interface OperationCounts {
  create: number;
  update: number;
  delete: number;
}

function countOperations(changes: PatchChange[]): OperationCounts {
  return {
    create: changes.filter((change) => change.operation === "create").length,
    update: changes.filter((change) => change.operation === "update").length,
    delete: changes.filter((change) => change.operation === "delete").length,
  };
}

function stableSort(changes: PatchChange[]): PatchChange[] {
  return [...changes].sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
  );
}

/**
 * 稳定排序后的有限路径摘要。加入每条路径前先检查长度，超出时保留计数并以 `... +N more` 结束。
 * 只写路径和操作，绝不包含文件正文。
 */
function buildSummary(prefix: string, changes: PatchChange[]): string {
  const entries = changes.map((change) => `${change.relativePath}(${change.operation})`);
  const parts: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const remaining = entries.length - index - 1;
    const reserve = remaining > 0 ? `, ... +${remaining} more`.length : 0;
    const candidate = parts.length === 0 ? entries[index]! : `${parts.join(", ")}, ${entries[index]!}`;
    if (prefix.length + 2 + candidate.length + reserve > MAX_SUMMARY_LENGTH) break;
    parts.push(entries[index]!);
  }
  const omitted = entries.length - parts.length;
  const suffix = omitted > 0 ? `${parts.length > 0 ? ", " : ""}... +${omitted} more` : "";
  const body = parts.join(", ") + suffix;
  return body ? `${prefix}: ${body}` : prefix;
}

function patchSuccess(changes: PatchChange[]): ToolResult {
  const counts = countOperations(changes);
  const header =
    `ApplyPatch ${changes.length} files: ${counts.create} created, ${counts.update} updated, ${counts.delete} deleted`;
  return {
    content: [{
      type: "text",
      text: `Applied patch to ${changes.length} files: ${counts.create} created, ${counts.update} updated, ${counts.delete} deleted.`,
    }],
    executionState: "completed",
    compactSummary: buildSummary(header, changes),
  };
}

function patchPartialFailure(
  completed: PatchChange[],
  pending: PatchChange[],
  error: unknown,
): ToolResult {
  const describe = (list: PatchChange[]): string =>
    list.length > 0 ? list.map((change) => change.relativePath).join(", ") : "none";
  const header = `ApplyPatch incomplete: ${completed.length} completed, ${pending.length} pending`;
  return {
    content: [{
      type: "text",
      text:
        `ApplyPatch stopped after ${completed.length} of ${completed.length + pending.length} files: ${error}. ` +
        `Completed: ${describe(completed)}. Pending: ${describe(pending)}. ` +
        "Files may be partially applied; inspect the workspace.",
    }],
    isError: true,
    failureKind: "unknown_outcome",
    executionState: "unknown",
    recoveryHint: "写入可能已部分生效；逐一检查已完成与未完成文件的实际状态，不要假设已回滚。",
    compactSummary: buildSummary(header, [...completed, ...pending]),
  };
}

/** 把 ApplyPatch 的已知错误映射成稳定反馈；未知异常一律标为结果不确定。 */
export function patchErrorResult(error: unknown): ToolResult {
  if (error instanceof PatchToolError) {
    return {
      content: [{ type: "text", text: `Error applying patch: ${error.message}` }],
      isError: true,
      failureKind: error.kind,
      executionState: "not_started",
      ...(error.recoveryHint ? { recoveryHint: error.recoveryHint } : {}),
    };
  }
  return {
    content: [{ type: "text", text: `Error applying patch: ${error}` }],
    isError: true,
    failureKind: "unknown_outcome",
    executionState: "unknown",
    recoveryHint: "补丁可能已部分生效；先检查工作区实际状态。",
  };
}

/**
 * 执行已预演的 patch：写盘前 best-effort 复核 update/delete 原始字节 hash，
 * 然后按稳定路径顺序落盘。首版只承诺“预演全有或全无”，不承诺跨文件磁盘回滚。
 */
export async function executePatchPlan(plan: PatchPlan, operations: FileOperations): Promise<ToolResult> {
  for (const change of plan.changes) {
    if (change.beforeHash === undefined) continue;
    let current: Uint8Array;
    try {
      const item = await operations.stat(change.executionPath);
      if (!item.isFile || item.isSymbolicLink) {
        throw new PatchToolError("invalid_input", `Patch target is no longer a regular file: ${change.relativePath}`);
      }
      current = await operations.readBytes(change.executionPath);
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        throw new PatchToolError(
          "invalid_input",
          `Patch target changed or disappeared before writing: ${change.relativePath}`,
        );
      }
      throw error;
    }
    if (sha256(current) !== change.beforeHash) {
      throw new PatchToolError("invalid_input", `Patch target changed after planning: ${change.relativePath}`);
    }
  }

  const ordered = stableSort(plan.changes);
  const completed: PatchChange[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const change = ordered[index]!;
    try {
      if (change.operation === "create") {
        await operations.createTextExclusive(change.executionPath, change.newContent);
      } else if (change.operation === "update") {
        await operations.writeTextAtomic(change.executionPath, change.newContent);
      } else {
        await operations.removeFile(change.executionPath);
      }
      completed.push(change);
    } catch (error) {
      return patchPartialFailure(completed, ordered.slice(index), error);
    }
  }
  return patchSuccess(ordered);
}

export const applyPatchTool: ToolDefinition = {
  name: "ApplyPatch",
  description:
    "Apply a standard unified diff for multi-file or multi-hunk text changes. Supports create, update, and delete; rejects rename, binary, fuzzy, and mode patches.",
  inputSchema: {
    type: "object",
    properties: { patch: { type: "string", description: "Standard unified diff." } },
    required: ["patch"],
  },
  async execute(input, context) {
    try {
      const plan = await planPatch(input.patch as string, context);
      return await executePatchPlan(plan, fileOperationsFor(context));
    } catch (error) {
      return patchErrorResult(error);
    }
  },
};
