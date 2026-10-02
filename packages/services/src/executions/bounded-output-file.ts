import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";

/** 后台任务日志在磁盘上的默认上限。只保留最新的内容。 */
export const MAX_PERSISTED_EXECUTION_OUTPUT_BYTES = 10 * 1024 * 1024;

export function appendBoundedOutput(
  path: string,
  data: string | Buffer,
  maxBytes = MAX_PERSISTED_EXECUTION_OUTPUT_BYTES,
  mode: "tail" | "prefix" = "tail",
): { retainedBytes: number; discardedBytes: number } {
  const incoming = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const existingBytes = existsSync(path) ? statSync(path).size : 0;
  if (mode === "prefix") {
    const text = Buffer.isBuffer(data) ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data) : data;
    let retainedBytes = 0;
    let end = 0;
    for (const character of text) {
      const bytes = Buffer.byteLength(character);
      if (existingBytes + retainedBytes + bytes > maxBytes) break;
      end += character.length;
      retainedBytes += bytes;
    }
    if (retainedBytes > 0) appendFileSync(path, text.slice(0, end));
    return { retainedBytes, discardedBytes: incoming.length - retainedBytes };
  }
  if (incoming.length >= maxBytes) {
    writeFileSync(path, incoming.subarray(incoming.length - maxBytes));
    return { retainedBytes: Math.min(incoming.length, maxBytes), discardedBytes: existingBytes + incoming.length - maxBytes };
  }

  if (existingBytes + incoming.length <= maxBytes) {
    appendFileSync(path, incoming);
    return { retainedBytes: incoming.length, discardedBytes: 0 };
  }

  const keepExistingBytes = maxBytes - incoming.length;
  const tail = Buffer.alloc(Math.min(existingBytes, keepExistingBytes));
  if (tail.length > 0) {
    const file = openSync(path, "r");
    try {
      readSync(file, tail, 0, tail.length, existingBytes - tail.length);
    } finally {
      closeSync(file);
    }
  }
  writeFileSync(path, Buffer.concat([tail, incoming]));
  return { retainedBytes: incoming.length, discardedBytes: existingBytes - tail.length };
}

export function writeBoundedOutput(
  path: string,
  data: string | Buffer,
  maxBytes = MAX_PERSISTED_EXECUTION_OUTPUT_BYTES,
): void {
  const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
  writeFileSync(path, content.length > maxBytes ? content.subarray(content.length - maxBytes) : content);
}
