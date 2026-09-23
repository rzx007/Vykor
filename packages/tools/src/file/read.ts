import { extname } from "node:path";
import type { ToolDefinition } from "@openharness/core";
import { resolveToolPathInContext } from "./environment-path.js";
import { sandboxPathError } from "./sandbox-guard.js";
import { fileOperationsFor } from "./operations.js";

export const fileReadTool: ToolDefinition = {
  name: "Read",
  description: "Read a local text file, image, or directory.",
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
    const offset = (input.offset as number) ?? 1;
    const limit = (input.limit as number) ?? 2000;

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
      const fileStat = await operations.stat(filePath);
      if (fileStat.isDirectory) {
        const entries = await operations.listDir(filePath);
        const start = Math.max(0, offset - 1);
        const end = start + limit;
        const listed = entries
          .sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name);
          })
          .slice(start, end)
          .map((entry) => `${entry.name}${entry.isDirectory ? "/" : ""}`)
          .join("\n");
        return {
          content: [{ type: "text", text: listed || "(empty directory)" }],
        };
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
        throw new Error("Unsupported binary file");
      }
      if (content.includes("\0")) throw new Error("Unsupported binary file");
      const lines = content.split("\n");
      const start = Math.max(0, offset - 1);
      const end = start + limit;
      const slice = lines.slice(start, end);
      const numbered = slice
        .map((line, i) => `${start + i + 1}: ${line}`)
        .join("\n");
      return { content: [{ type: "text", text: numbered }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error reading file: ${error}` }],
        isError: true,
      };
    }
  },
};

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
