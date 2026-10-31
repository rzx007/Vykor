import type { FileToolHost } from "../ports/policy.js";
import { createHash } from "node:crypto";
import { extname, posix, win32 } from "node:path";
import { type ToolContext, type ToolDefinition, type ToolResult } from "@vykor/agent-contracts";
import { resolveToolPathInContext } from "./access/environment-path.js";
import { sandboxPathError } from "./access/sandbox-guard.js";
import { isFileNotFoundError, fileOperationsFor, type FileOperations } from "./operations.js";
import { decodeUtf8Text, isBinaryContent } from "./text-content.js";
import { managedPersistencePathKind } from "./access/managed-persistence-path.js";
import { isSystemPath } from "./access/file-mutation-guard.js";
import { targetProjectInstructions } from "./instructions.js";

export { BINARY_CONTROL_RATIO, BINARY_SAMPLE_CHARS, isBinaryContent } from "./text-content.js";

export const DEFAULT_READ_LIMIT = 2000;
export const MAX_READ_BYTES = 50 * 1024;
export const MAX_READ_BYTES_LABEL = "50 KB";
export const MAX_LINE_LENGTH = 2000;
export const MAX_LINE_SUFFIX = ` ... (line truncated to ${MAX_LINE_LENGTH} chars)`;
export const MAX_SUGGESTIONS = 3;
/** Input/scan budget, independent of the 50 KB formatted output budget. */
export const MAX_READ_INPUT_BYTES = 1024 * 1024;
export const MAX_READ_INFO_BYTES = 8 * 1024 * 1024;
/** Matches api's DEFAULT_MAX_VISION_SOURCE_BYTES without coupling tools to a provider. */
export const MAX_READ_IMAGE_BYTES = 20 * 1024 * 1024;

export function fileDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Stable environment/workspace identity, independent of a Run or environment lease. */
export function hostFileFacts(context: ToolContext, files: Array<{
  path: string; operation: "read" | "write" | "edit" | "patch";
  beforeDigest?: string; afterDigest: string; bodyVisible?: boolean;
}>) {
  const info = context.environment?.info;
  const workspace = context.environment?.workspace;
  const pathStyle = info?.pathStyle ?? (process.platform === "win32" ? "windows" : "posix");
  const identityPath = (path: string) => pathStyle === "windows" ? win32.normalize(path).toLowerCase() : posix.normalize(path);
  const environmentKey = `environment:${createHash("sha256").update(JSON.stringify({
    kind: info?.kind ?? workspace?.kind ?? "local",
    pathStyle,
    hostRoot: identityPath(workspace?.hostRoot ?? context.cwd),
    executionRoot: identityPath(workspace?.executionRoot ?? context.cwd),
    shell: info?.shellDescriptor,
  })).digest("hex")}`;
  return { environmentKey, executionRoot: workspace?.executionRoot ?? context.cwd, pathStyle, files: files.map(file => ({ ...file, completed: true as const,
    subjectKey: `file:${createHash("sha256").update(environmentKey).update("\0").update(identityPath(file.path)).digest("hex")}`,
  })) };
}

export function normalizeReadInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.trunc(value))
    : fallback;
}

/** 行数规则：空串为 0 行；只剥一个尾随 \n；不做行尾归一。 */
export function splitReadLines(content: string): string[] {
  if (content === "") return [];
  return (content.endsWith("\n") ? content.slice(0, -1) : content).split("\n");
}

export function truncateReadLine(line: string): string {
  return line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : line;
}

export type ReadSlice = {
  lines: string[];
  emitted: number;
  byteCapped: boolean;
};

function sliceReadItems(
  items: string[],
  offset: number,
  limit: number,
  format: (item: string, index: number) => string,
): ReadSlice {
  const start = offset - 1;
  const output: string[] = [];
  let bytes = 0;
  let byteCapped = false;

  for (let index = start; index < items.length; index += 1) {
    if (output.length >= limit) break;
    const text = format(items[index]!, index);
    const size = Buffer.byteLength(text, "utf8") + (output.length > 0 ? 1 : 0);
    if (output.length > 0 && bytes + size > MAX_READ_BYTES) {
      byteCapped = true;
      break;
    }
    output.push(text);
    bytes += size;
  }

  return { lines: output, emitted: output.length, byteCapped };
}

/** 从 offset 开始取最多 limit 行，先截断单行，再执行总字节上限。 */
export function sliceReadLines(lines: string[], offset: number, limit: number): ReadSlice {
  return sliceReadItems(
    lines,
    offset,
    limit,
    (line, index) => `${index + 1}: ${truncateReadLine(line)}`,
  );
}

export function sliceDirectoryEntries(entries: string[], offset: number, limit: number): ReadSlice {
  return sliceReadItems(entries, offset, limit, (entry) => truncateReadLine(entry));
}

/** 尾部提示：按 remaining 判定行数提示与结束提示，避免"读完却提示续读"。 */
export function readTrailer(input: {
  offset: number;
  emitted: number;
  total: number;
  byteCapped: boolean;
}): string {
  const first = input.offset;
  const last = input.offset + input.emitted - 1;
  const next = last + 1;

  if (input.byteCapped) {
    return `(Output capped at ${MAX_READ_BYTES_LABEL}. Showing lines ${first}-${last}. Use offset=${next} to continue.)`;
  }

  const remaining = input.total - (input.offset - 1) - input.emitted;
  if (remaining > 0) {
    return `(Showing lines ${first}-${last} of ${input.total}. Use offset=${next} to continue.)`;
  }

  return `(End of file - total ${input.total} lines)`;
}

/** 名称互相包含（忽略大小写），最多 MAX_SUGGESTIONS 条。 */
export function suggestSimilarNames(target: string, entries: string[]): string[] {
  const base = target.toLowerCase();
  if (!base) return [];
  return entries
    .filter((name) => {
      const lower = name.toLowerCase();
      return lower.includes(base) || base.includes(lower);
    })
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_SUGGESTIONS);
}

/** 诊断是否可用只影响说明，不改变原始读取失败的事实。 */
function readErrorResult(error: unknown, started = true): ToolResult {
  const missing = isFileNotFoundError(error);
  return {
    content: [{ type: "text", text: `Error reading file: ${error}` }], isError: true,
    failureKind: missing ? "precondition" : "unknown_outcome",
    executionState: started ? "completed" : "not_started",
  };
}

function readPrecondition(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true, failureKind: "precondition", executionState: "completed" };
}

export function createFileReadTool(host: FileToolHost = {}): ToolDefinition {
  const tool: ToolDefinition = {
    name: "Read",
    description:
      "Read a local text file, supported image, or directory. For Shell output use file_path=shell-output://UUID and cursor=0 (UTF-8 byte position); omit info_only/offset/limit. Use info_only=true to inspect local target existence, type and full raw-byte SHA-256 (files up to 8 MiB) without returning its body or changing files; this does not authorize a write. Otherwise local text is returned with each line prefixed as `N: <content>`. Text scans at most the first 1 MiB plus a one-byte truncation probe; offset beyond that scan is refused, total lines may be unknown, and incomplete scans have no full-file hash receipt. Use `offset` (1-indexed) and `limit` within the scanned prefix. Lines longer than 2000 characters and output beyond 50 KB are truncated with a note. Supported images up to 20 MiB are returned as image blocks; other binary files are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "An absolute or working-directory-relative local path, or shell-output://UUID from Shell.",
        },
        cursor: { type: "number", description: "For shell-output:// only: UTF-8 byte cursor (default 0)." },
        offset: { type: "number", description: "Start line (1-indexed)." },
        limit: { type: "number", description: "Max lines to read." },
        info_only: { type: "boolean", description: "Only inspect a local file target's state and overwrite conditions. No body or mutation; not a permission grant." },
      },
      required: ["file_path"],
    },
    async execute(input, context) {
      if (input.info_only !== undefined && typeof input.info_only !== "boolean") {
        return { content: [{ type: "text", text: "info_only must be boolean." }], isError: true, failureKind: "invalid_input", executionState: "not_started" };
      }
      const rawPath = input.file_path as string;
      if (typeof rawPath === "string" && /^shell-output:/i.test(rawPath)) {
        return readShellOutput(input, context, rawPath, host);
      }
      if (input.cursor !== undefined) {
        return { content: [{ type: "text", text: "cursor is only for shell-output:// references; use offset/limit for ordinary files." }], isError: true, failureKind: "invalid_input", executionState: "not_started" };
      }
      const cwd = (context as { cwd?: string } | undefined)?.cwd ?? process.cwd();
      const offset = normalizeReadInteger(input.offset, 1);
      const limit = normalizeReadInteger(input.limit, DEFAULT_READ_LIMIT);

      let started = false;
      try {
        const filePath = await resolveToolPathInContext(rawPath, context, "read");
        const sandboxError = await sandboxPathError(filePath, cwd, "read", host.settings, context.environment);
        if (sandboxError) {
          return {
            content: [{ type: "text", text: sandboxError }],
            isError: true,
            failureKind: "policy",
            executionState: "not_started",
            recoveryHint: "此路径被读取策略限制；遵守限制，不能换工具绕过。",
          };
        }

        if (context.abortSignal?.aborted) return { content: [{ type: "text", text: "Read cancelled before execution." }], isError: true, failureKind: "interrupted", executionState: "not_started" };
        const operations = fileOperationsFor(context);
        started = true;
        if (input.info_only === true) return await inspectFileInfo(operations, filePath, rawPath, context, host);
        let fileStat: Awaited<ReturnType<FileOperations["stat"]>>;
        try {
          fileStat = await operations.stat(filePath, context.abortSignal);
        } catch (statError) {
          context.abortSignal?.throwIfAborted();
          return await describeMissingPath(operations, filePath, statError, context, host);
        }
        if (fileStat.isDirectory) {
          return await readDirectoryListing(operations, filePath, offset, limit);
        }

        const expectedMediaType = IMAGE_EXTENSIONS[extname(filePath).toLowerCase()];
        if (expectedMediaType && (fileStat.sizeBytes ?? 0) > MAX_READ_IMAGE_BYTES) {
          return readPrecondition(`Image exceeds the ${MAX_READ_IMAGE_BYTES} byte image input limit: ${filePath}`);
        }
        let bytes = await operations.readBytes(filePath, {
          maxBytes: (expectedMediaType ? MAX_READ_IMAGE_BYTES : MAX_READ_INPUT_BYTES) + 1,
          signal: context.abortSignal,
        });
        context.abortSignal?.throwIfAborted();
        const mediaType = imageMediaType(bytes);
        if (expectedMediaType && mediaType !== expectedMediaType) {
          throw new Error(`Invalid image file: expected ${expectedMediaType} content`);
        }
        if (mediaType) {
          if ((fileStat.sizeBytes ?? 0) > MAX_READ_IMAGE_BYTES) {
            return readPrecondition(`Image exceeds the ${MAX_READ_IMAGE_BYTES} byte image input limit: ${filePath}`);
          }
          // Extensionless images retain signature-based detection. Their initial text-sized
          // probe is bounded too; only media may request a second, image-sized bounded read.
          if (!expectedMediaType && bytes.byteLength > MAX_READ_INPUT_BYTES) {
            bytes = await operations.readBytes(filePath, { maxBytes: MAX_READ_IMAGE_BYTES + 1, signal: context.abortSignal });
            context.abortSignal?.throwIfAborted();
            if (imageMediaType(bytes) !== mediaType) return readPrecondition(`Image changed while reading: ${filePath}`);
          }
          if (bytes.byteLength > MAX_READ_IMAGE_BYTES) return readPrecondition(`Image exceeds the ${MAX_READ_IMAGE_BYTES} byte image input limit: ${filePath}`);
          const hostPath = context.environment
            ? context.environment.paths.toHostPath(filePath)
            : filePath;
          if (!hostPath) throw new Error("Image file is not accessible to the model provider");
          return {
            content: [{
              type: "image",
              source: { type: "file", mediaType, path: hostPath, sizeBytes: bytes.byteLength },
            }],
            executionState: "completed",
            compactSummary: `Read completed: ${filePath}; image`,
          };
        }

        const inputCapped = bytes.byteLength > MAX_READ_INPUT_BYTES;
        let content: string;
        try {
          if (inputCapped) {
            // Streaming mode retains only an incomplete trailing UTF-8 sequence (at most
            // three bytes); invalid sequences inside the prefix still throw.
            content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, MAX_READ_INPUT_BYTES), { stream: true });
            if (isBinaryContent(content)) throw new Error("Unsupported binary content");
          } else content = decodeUtf8Text(bytes);
        } catch {
          return {
            content: [{ type: "text", text: `Cannot read binary file: ${filePath}` }],
            isError: true,
            failureKind: "precondition",
            executionState: "completed",
          };
        }

        const lines = splitReadLines(content);
        const total = lines.length;
        if (offset > total && !(total === 0 && offset === 1)) {
          if (inputCapped) return readPrecondition(`Offset ${offset} exceeds the 1 MiB input scan budget; the total line count is unknown. Read a smaller file or a dedicated bounded slice.`);
          return {
            content: [{ type: "text", text: `Offset ${offset} is out of range for this file (${total} lines)` }],
            isError: true,
            failureKind: "precondition",
            executionState: "completed",
          };
        }

        const slice = sliceReadLines(lines, offset, limit);
        const body = slice.lines.join("\n");
        const incompleteLine = inputCapped && !content.endsWith("\n");
        const trailer = inputCapped ? boundedReadTrailer({ offset, slice, total, incompleteLine }) : readTrailer({
          offset,
          emitted: slice.emitted,
          total,
          byteCapped: slice.byteCapped,
        });
        return {
          content: [{ type: "text", text: body ? `${body}\n\n${trailer}` : trailer }],
          ...(!inputCapped ? { metadata: { hostFileFacts: hostFileFacts(context, [{ path: filePath, operation: "read", afterDigest: fileDigest(bytes), bodyVisible: true }]) } } : {}),
          executionState: "completed",
          compactSummary: `Read completed: ${filePath}; lines=${offset}-${offset + slice.emitted - 1}; total=${inputCapped ? "unknown; input capped at 1 MiB" : total}`,
        };
      } catch (error) {
        if (context.abortSignal?.aborted) return { content: [{ type: "text", text: "Read cancelled." }], isError: true, failureKind: "interrupted", executionState: started ? "completed" : "not_started" };
        return readErrorResult(error, started);
      }
    },
  };
  return { ...tool, async execute(input, context) {
    const result = await tool.execute(input, context);
    if (result.isError || typeof input.file_path !== "string" || /^shell-output:/i.test(input.file_path)) return result;
    try {
      const path = await resolveToolPathInContext(input.file_path, context, "read");
      const instructions = await targetProjectInstructions([path], context, host);
      if (!instructions) return result;
      // Keep the ordinary Read output budget, including the additional rule blocks.
      const instructionBytes = Buffer.byteLength(JSON.stringify(instructions.content), "utf8");
      let remaining = Math.max(0, MAX_READ_BYTES - instructionBytes - 300);
      const content = result.content.map(block => {
        if (block.type !== "text") return block;
        const bytes = Buffer.from(block.text, "utf8");
        if (bytes.byteLength <= remaining) { remaining -= bytes.byteLength; return block; }
        const text = new TextDecoder().decode(bytes.subarray(0, remaining));
        remaining = 0;
        return { type: "text" as const, text: text + "\n[Read output shortened to include project instructions; repeat Read for the file body.]" };
      });
      return { ...result, content: [...instructions.content, ...content], metadata: { ...result.metadata, ...instructions.metadata } };
    } catch (error) { return readErrorResult(error); }
  } };
}

export const fileReadTool: ToolDefinition = createFileReadTool();

function boundedReadTrailer(input: { offset: number; slice: ReadSlice; total: number; incompleteLine: boolean }): string {
  const last = input.offset + input.slice.emitted - 1;
  const next = last + 1;
  const continuation = last < input.total ? ` Use offset=${next} to continue within the scanned prefix.`
    : " The scan budget prevents continuing beyond this prefix; use a smaller file or a dedicated bounded slice.";
  return `(Input scan capped at 1 MiB; total lines unknown. Showing lines ${input.offset}-${last}.${input.slice.byteCapped ? ` Output capped at ${MAX_READ_BYTES_LABEL}.` : ""}${input.incompleteLine && last === input.total ? " Last shown line is incomplete." : ""}${continuation})`;
}

async function readShellOutput(
  input: Record<string, unknown>,
  context: import("@vykor/agent-contracts").ToolContext,
  reference: string,
  host: FileToolHost,
): Promise<ToolResult> {
  const invalid = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true, failureKind: "invalid_input", executionState: "not_started" });
  if (input.info_only !== undefined || input.offset !== undefined || input.limit !== undefined) {
    return invalid('For Shell logs use Read(file_path="shell-output://UUID", cursor=0); omit info_only, offset and limit.');
  }
  const cursor = input.cursor ?? 0;
  if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0) return invalid("cursor must be a non-negative safe UTF-8 byte position.");
  if (!host.shellOutputLogs || !context.sessionId) return {
    content: [{ type: "text", text: "Shell output reference unavailable in this session." }],
    isError: true, failureKind: "configuration", executionState: "not_started",
  };
  const budget = (host.outputPolicy?.inlineChars ?? 16_000);
  let maxBytes = Math.min(8192, Math.max(4, budget - 160));
  for (;;) {
    const page = await host.shellOutputLogs.read({ sessionId: context.sessionId, reference, cursor, maxBytes });
    if (page.status !== "ok") return page.status === "invalid_cursor"
      ? invalid("Invalid Shell output cursor: use a UTF-8 character boundary within retained bytes.")
      : { content: [{ type: "text", text: "Shell output reference unavailable in this session." }],
          isError: true, failureKind: "precondition", executionState: "completed" };
    const header = `Shell output: cursor=${cursor}; nextCursor=${page.nextCursor}; eof=${page.eof}; retainedBytes=${page.retainedBytes}; discardedBytes=${page.discardedBytes}; complete=${page.complete}\n`;
    if (header.length + page.text.length <= budget) {
      return { content: [{ type: "text", text: header + page.text }], executionState: "completed", compactSummary: `Read Shell output: cursor=${cursor}; nextCursor=${page.nextCursor}` };
    }
    maxBytes = Math.max(4, maxBytes - (header.length + page.text.length - budget) - 4);
  }
}

async function inspectFileInfo(
  operations: FileOperations,
  filePath: string,
  rawPath: string,
  context: import("@vykor/agent-contracts").ToolContext,
  host: FileToolHost,
): Promise<import("@vykor/agent-contracts").ToolResult> {
  let item: Awaited<ReturnType<FileOperations["stat"]>> | undefined;
  try { item = await operations.stat(filePath, context.abortSignal); }
  catch (error) { if (!isFileNotFoundError(error)) throw error; }
  const kind = !item ? "missing" : item.isSymbolicLink ? "symlink"
    : item.isFile ? "file" : item.isDirectory ? "directory" : "other";
  const info: Record<string, unknown> = {
    path: filePath, exists: item !== undefined, kind, parentExists: item ? true : null,
    note: "This is a read-only snapshot, not write authorization. Write creates or fully replaces content subject to current permissions; writes recheck current state.",
  };
  if (!item) {
    const parent = readPathInfo(filePath).parent;
    const denied = await sandboxPathError(parent, context.cwd, "read", host.settings, context.environment);
    if (!denied) {
      try { info.parentExists = (await operations.stat(parent)).isDirectory; }
      catch (error) { if (isFileNotFoundError(error)) info.parentExists = false; }
    }
  }
  if (item?.isFile) {
    if ((item.sizeBytes ?? 0) > MAX_READ_INFO_BYTES) return readPrecondition(`Full-file SHA-256 hash exceeds the ${MAX_READ_INFO_BYTES} byte info_only hash limit; no hash was computed. Use a smaller file or an external full-file hashing workflow.`);
    const bytes = await operations.readBytes(filePath, { maxBytes: MAX_READ_INFO_BYTES + 1, signal: context.abortSignal });
    context.abortSignal?.throwIfAborted();
    if (bytes.byteLength > MAX_READ_INFO_BYTES) return readPrecondition(`Full-file SHA-256 hash exceeds the ${MAX_READ_INFO_BYTES} byte info_only hash limit; no hash was computed. A prefix is not a full-file hash.`);
    info.sizeBytes = bytes.byteLength;
    info.sha256 = createHash("sha256").update(bytes).digest("hex");
  }
  const policy = isSystemPath(rawPath) || isSystemPath(filePath)
    ? "System paths cannot be modified."
    : managedPersistencePathKind(filePath, context.cwd)
      ? "Managed persistence paths must use their dedicated tool."
      : await sandboxPathError(filePath, context.cwd, "write", host.settings, context.environment);
  if (policy) info.writePolicyError = policy;
  return {
    content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
    metadata: { fileInfo: info, ...((kind === "file" || kind === "missing") ? {
      hostFileFacts: hostFileFacts(context, [{ path: filePath, operation: "read", afterDigest: kind === "missing" ? "missing" : `sha256:${info.sha256}`, bodyVisible: false }]),
    } : {}) }, executionState: "completed",
    compactSummary: `Read file info: ${filePath}; ${kind}; no write authorization`,
  };
}

async function readDirectoryListing(
  operations: FileOperations,
  dir: string,
  offset: number,
  limit: number,
): Promise<import("@vykor/agent-contracts").ToolResult> {
  const entries = (await operations.listDir(dir)).sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const total = entries.length;
  if (total === 0) {
    if (offset === 1) return { content: [{ type: "text", text: "(empty directory)" }], executionState: "completed", compactSummary: `Read completed: ${dir}; 0 entries` };
    return {
      content: [{ type: "text", text: `Offset ${offset} is out of range for this directory (0 entries)` }],
      isError: true, failureKind: "precondition", executionState: "completed",
    };
  }

  if (offset > total) {
    return {
      content: [{ type: "text", text: `Offset ${offset} is out of range for this directory (${total} entries)` }],
      isError: true,
      failureKind: "precondition",
      executionState: "completed",
    };
  }

  const formatted = entries.map((entry) => `${entry.name}${entry.isDirectory ? "/" : ""}`);
  const slice = sliceDirectoryEntries(formatted, offset, limit);
  const body = slice.lines.join("\n");
  const remaining = total - (offset - 1) - slice.emitted;
  const first = offset;
  const last = offset + slice.emitted - 1;
  const next = offset + slice.emitted;
  const trailer = slice.byteCapped
    ? `(Output capped at ${MAX_READ_BYTES_LABEL}. Showing entries ${first}-${last} of ${total}. Use offset=${next} to continue.)`
    : remaining > 0
      ? `(Showing entries ${first}-${last} of ${total}. Use offset=${next} to continue.)`
      : offset === 1
        ? `(${total} entries)`
        : `(Showing entries ${first}-${last} of ${total}. End of directory.)`;

  return { content: [{ type: "text", text: `${body}\n\n${trailer}` }], executionState: "completed", compactSummary: `Read completed: ${dir}; entries=${first}-${last}; total=${total}` };
}

export function readPathInfo(filePath: string): {
  name: string;
  parent: string;
  sibling: (name: string) => string;
} {
  const pathApi = /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.includes("\\")
    ? win32
    : posix;
  const parent = pathApi.dirname(filePath);
  return {
    name: pathApi.basename(filePath),
    parent,
    sibling: (name) => pathApi.join(parent, name),
  };
}

export function missingPathMessage(
  filePath: string,
  entryNames: string[],
  statError: unknown,
): string {
  const pathInfo = readPathInfo(filePath);
  if (entryNames.includes(pathInfo.name)) return `Error reading file: ${statError}`;

  const suggestions = suggestSimilarNames(pathInfo.name, entryNames)
    .map(pathInfo.sibling);
  const lines = [`File not found: ${filePath}`];
  if (suggestions.length > 0) {
    lines.push("", "Did you mean one of these?", ...suggestions);
  }
  return lines.join("\n");
}

/** stat 失败后：父目录能列出时给建议，否则保留原始错误。 */
async function describeMissingPath(
  operations: FileOperations,
  filePath: string,
  statError: unknown,
  context: import("@vykor/agent-contracts").ToolContext,
  host: FileToolHost,
): Promise<import("@vykor/agent-contracts").ToolResult> {
  let entries: Awaited<ReturnType<FileOperations["listDir"]>>;
  const pathInfo = readPathInfo(filePath);
  const failure = readErrorResult(statError);
  const missing = failure.failureKind === "precondition";
  try {
    const denied = await sandboxPathError(pathInfo.parent, context.cwd, "read", host.settings, context.environment);
    if (denied) return failure;
    entries = await operations.listDir(pathInfo.parent);
  } catch {
    return failure;
  }

  return {
    ...failure,
    content: [{
      type: "text",
      text: missing ? missingPathMessage(filePath, entries.map((entry) => entry.name), statError) : `Error reading file: ${statError}`,
    }],
    recoveryHint: missing ? "检查父目录及文件名称；可根据候选名称重新指定路径。" : "检查路径和实际文件状态。",
  };
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function imageMediaType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return "image/jpeg";
  }
  const header = new TextDecoder("utf-8").decode(bytes.subarray(0, 12));
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return "image/webp";
  return undefined;
}
