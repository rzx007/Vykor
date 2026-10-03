import { createHash } from "node:crypto";
import { parseTextEdits, planTextEdits } from "./edit-plan.js";
import { decodeUtf8Text } from "./text-content.js";
import { HostFileOperations, isFileNotFoundError } from "./operations.js";

/**
 * 一次文件改动的预览：路径 + 改动前内容 + 改动后内容。**不写盘**。
 */
export interface FileChangePreview {
  path: string;
  before: string;
  after: string;
}

/**
 * 计算宿主文件的 Edit/Write 改动，供调用方生成预览。这里不授予权限。
 *
 * **不写盘**：Edit 与执行入口共用替换计算；具体执行环境、权限和写前
 * 冲突检查仍由执行入口负责，不能把这个宿主预览当作安全授权。
 *
 * 返回 `null` 的情况（调用方应回退到无 diff 的普通确认）：
 * - 非 Edit/Write 工具（无 diff 概念）。
 * - 入参缺字段。
 * - Edit 的 old_string 在文件中找不到，或多处匹配但未 replace_all
 *   ——这些情况工具执行时本就会报错，没有可预览的 after。
 * - 读文件失败（Edit 针对不存在的文件）。
 */
export async function computeFileChange(
  toolName: string,
  input: Record<string, unknown>,
): Promise<FileChangePreview | null> {
  if (toolName === "Write") return computeWriteChange(input);
  if (toolName === "Edit") return computeEditChange(input);
  return null;
}

async function computeWriteChange(
  input: Record<string, unknown>,
): Promise<FileChangePreview | null> {
  const path = input.file_path;
  const content = input.content;
  if (Object.keys(input).some(key => !["file_path", "content", "expected_sha256"].includes(key))
    || typeof path !== "string" || typeof content !== "string"
    || (input.expected_sha256 !== undefined && (typeof input.expected_sha256 !== "string"
      || !/^[a-f0-9]{64}$/i.test(input.expected_sha256)))) return null;

  const operations = new HostFileOperations();
  try {
    const item = await operations.stat(path);
    if (!item.isFile || item.isSymbolicLink) return null;
    const bytes = await operations.readBytes(path);
    const before = decodeUtf8Text(bytes);
    if (before !== content && typeof input.expected_sha256 === "string"
      && createHash("sha256").update(bytes).digest("hex") !== input.expected_sha256.toLowerCase()) return null;
    return { path, before, after: content };
  } catch (error) {
    // 只有不存在可视为新建；权限／编码／其他读取错误不能伪装成空文件。
    return isFileNotFoundError(error) && input.expected_sha256 === undefined ? { path, before: "", after: content } : null;
  }
}

async function computeEditChange(
  input: Record<string, unknown>,
): Promise<FileChangePreview | null> {
  const path = input.file_path;
  if (typeof path !== "string") return null;
  try {
    parseTextEdits(input);
    const operations = new HostFileOperations();
    const item = await operations.stat(path);
    if (!item.isFile || item.isSymbolicLink) return null;
    const bytes = await operations.readBytes(path);
    if (input.expected_sha256 !== undefined && (typeof input.expected_sha256 !== "string"
      || !/^[a-f0-9]{64}$/i.test(input.expected_sha256)
      || createHash("sha256").update(bytes).digest("hex") !== input.expected_sha256.toLowerCase())) return null;
    const before = decodeUtf8Text(bytes);
    return { path, before, after: planTextEdits(before, input).content };
  }
  catch { return null; }
}
