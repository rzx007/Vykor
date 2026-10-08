import { open } from "node:fs/promises"
import { isAbsolute } from "node:path"
import type { DesktopAttachmentPreview } from "@shared/attachment-types"
import type { DesktopSessionPart } from "@shared/session-types"
import { safeImageMediaTypeFromName } from "@shared/safe-image-preview"
import { evaluateInspectedImagePreview } from "../image-preview/inspect-safe-image-layout"

const maxPreviewBytes = 10 * 1024 * 1024
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? value as Record<string, unknown> : {}

/** 路径来自后台保存的工具结果，不接受界面传入文件路径。 */
export async function readToolImagePreview(part: DesktopSessionPart): Promise<DesktopAttachmentPreview> {
  const output = record(part.output)
  if (part.toolName !== "Read" || part.status !== "completed" || part.isError || output.isError)
    throw new Error("只能预览成功读取的图片")
  const content = Array.isArray(output.content) ? output.content : []
  const image = content.map(record).find(block => block.type === "image")
  const source = record(image?.source)
  const path = source.path
  if (source.type !== "file" || typeof path !== "string" || !isAbsolute(path))
    throw new Error("这条读取记录没有可预览的图片")
  const mediaType = safeImageMediaTypeFromName(path)
  if (!mediaType || source.mediaType !== mediaType) throw new Error("暂不支持这种图片格式")
  const file = await open(path, "r").catch(() => { throw new Error("图片文件不存在或无法读取") })
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error("图片来源不是文件")
    if (info.size > maxPreviewBytes) throw new Error("图片过大，无法展开预览（最大 10 MB）")
    // 即使文件在读取期间增长，也不无界分配内存。
    const buffer = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > info.size) throw new Error("图片已变化，请重试")
    const bytes = buffer.subarray(0, length)
    const decision = await evaluateInspectedImagePreview(bytes, mediaType)
    if (!decision.ok) throw new Error(decision.error === "image_too_large" ? "图片尺寸过大，无法展开预览" : "图片格式无效或无法解码")
    return { bytes: Uint8Array.from(bytes).buffer, mediaType }
  } finally { await file.close() }
}
