export const BINARY_SAMPLE_CHARS = 4096;
export const BINARY_CONTROL_RATIO = 0.3;

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

/**
 * 严格按 UTF-8 解码；遇到非法字节序列、NUL 或控制字符比例过高时抛出。
 * `ignoreBOM: true` 会保留 U+FEFF，BOM 的剥离由调用方按语义自行处理。
 */
export function decodeUtf8Text(bytes: Uint8Array): string {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("Unsupported binary content");
  }
  if (isBinaryContent(content)) throw new Error("Unsupported binary content");
  return content;
}
