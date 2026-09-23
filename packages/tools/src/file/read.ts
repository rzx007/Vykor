import { extname, posix, win32 } from "node:path";
import type { ToolDefinition } from "@openharness/core";
import { resolveToolPathInContext } from "./environment-path.js";
import { sandboxPathError } from "./sandbox-guard.js";
import { fileOperationsFor, type FileOperations } from "./operations.js";

export const DEFAULT_READ_LIMIT = 2000;
export const MAX_READ_BYTES = 50 * 1024;
export const MAX_READ_BYTES_LABEL = "50 KB";
export const MAX_LINE_LENGTH = 2000;
export const MAX_LINE_SUFFIX = ` ... (line truncated to ${MAX_LINE_LENGTH} chars)`;
export const BINARY_SAMPLE_CHARS = 4096;
export const BINARY_CONTROL_RATIO = 0.3;
export const MAX_SUGGESTIONS = 3;

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

/** 含 NUL，或前 4096 字符中控制字符占比超过阈值，即判定为二进制。 */
export function isBinaryContent(content: string): boolean {
  if (content.includes("\u0000")) return true;
  const sample = content.slice(0, BINARY_SAMPLE_CHARS);
  if (sample.length === 0) return false;
  let control = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index);
    if (code < 9 || (code > 13 && code < 32)) control += 1;
  }
  return control / sample.length > BINARY_CONTROL_RATIO;
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

export const fileReadTool: ToolDefinition = {
  name: "Read",
  description:
    "Read a local text file, supported image, or directory. Text is returned with each line prefixed as `N: <content>`. Use `offset` (1-indexed) and `limit` to continue through large files or directories. Lines longer than 2000 characters and text or directory output beyond 50 KB are truncated with a note. Supported images are returned as image blocks; other binary files are rejected.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "An absolute or working-directory-relative local path.",
      },
      offset: { type: "number", description: "Start line (1-indexed)." },
      limit: { type: "number", description: "Max lines to read." },
    },
    required: ["file_path"],
  },
  async execute(input, context) {
    const rawPath = input.file_path as string;
    const cwd = (context as { cwd?: string } | undefined)?.cwd ?? process.cwd();
    const offset = normalizeReadInteger(input.offset, 1);
    const limit = normalizeReadInteger(input.limit, DEFAULT_READ_LIMIT);

    try {
      const filePath = await resolveToolPathInContext(rawPath, context, "read");
      const sandboxError = await sandboxPathError(filePath, cwd, "read", context.settings, context.environment);
      if (sandboxError) {
        return {
          content: [{ type: "text", text: sandboxError }],
          isError: true,
        };
      }

      const operations = fileOperationsFor(context);
      let fileStat: Awaited<ReturnType<FileOperations["stat"]>>;
      try {
        fileStat = await operations.stat(filePath);
      } catch (statError) {
        const parentSandboxError = await sandboxPathError(
          readPathInfo(filePath).parent,
          cwd,
          "read",
          context.settings,
          context.environment,
        );
        if (parentSandboxError) {
          return {
            content: [{ type: "text", text: `Error reading file: ${statError}` }],
            isError: true,
          };
        }
        return await describeMissingPath(operations, filePath, statError);
      }
      if (fileStat.isDirectory) {
        return await readDirectoryListing(operations, filePath, offset, limit);
      }

      const bytes = await operations.readBytes(filePath);
      const mediaType = imageMediaType(bytes);
      const expectedMediaType = IMAGE_EXTENSIONS[extname(filePath).toLowerCase()];
      if (expectedMediaType && mediaType !== expectedMediaType) {
        throw new Error(`Invalid image file: expected ${expectedMediaType} content`);
      }
      if (mediaType) {
        const hostPath = context.environment
          ? context.environment.paths.toHostPath(filePath)
          : filePath;
        if (!hostPath) throw new Error("Image file is not accessible to the model provider");
        return {
          content: [{
            type: "image",
            source: { type: "file", mediaType, path: hostPath, sizeBytes: bytes.byteLength },
          }],
        };
      }

      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        return {
          content: [{ type: "text", text: `Cannot read binary file: ${filePath}` }],
          isError: true,
        };
      }
      if (isBinaryContent(content)) {
        return {
          content: [{ type: "text", text: `Cannot read binary file: ${filePath}` }],
          isError: true,
        };
      }

      const lines = splitReadLines(content);
      const total = lines.length;
      if (offset > total && !(total === 0 && offset === 1)) {
        return {
          content: [{ type: "text", text: `Offset ${offset} is out of range for this file (${total} lines)` }],
          isError: true,
        };
      }

      const slice = sliceReadLines(lines, offset, limit);
      const body = slice.lines.join("\n");
      const trailer = readTrailer({
        offset,
        emitted: slice.emitted,
        total,
        byteCapped: slice.byteCapped,
      });
      return {
        content: [{ type: "text", text: body ? `${body}\n\n${trailer}` : trailer }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error reading file: ${error}` }],
        isError: true,
      };
    }
  },
};

async function readDirectoryListing(
  operations: FileOperations,
  dir: string,
  offset: number,
  limit: number,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
  const entries = (await operations.listDir(dir)).sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const total = entries.length;
  if (total === 0) {
    if (offset === 1) return { content: [{ type: "text", text: "(empty directory)" }] };
    return {
      content: [{ type: "text", text: `Offset ${offset} is out of range for this directory (0 entries)` }],
      isError: true,
    };
  }

  if (offset > total) {
    return {
      content: [{ type: "text", text: `Offset ${offset} is out of range for this directory (${total} entries)` }],
      isError: true,
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

  return { content: [{ type: "text", text: `${body}\n\n${trailer}` }] };
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
): Promise<{ content: Array<{ type: "text"; text: string }>; isError: true }> {
  let entries: Awaited<ReturnType<FileOperations["listDir"]>>;
  const pathInfo = readPathInfo(filePath);
  try {
    entries = await operations.listDir(pathInfo.parent);
  } catch {
    return {
      content: [{ type: "text", text: `Error reading file: ${statError}` }],
      isError: true,
    };
  }

  return {
    content: [{
      type: "text",
      text: missingPathMessage(filePath, entries.map((entry) => entry.name), statError),
    }],
    isError: true,
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
