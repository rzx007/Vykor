import type { createReadStream } from "node:fs"

import type { AttachmentResource } from "@vykor/client"

export interface AttachmentClient {
  attachments: Pick<
    AttachmentResource,
    | "upload"
    | "get"
    | "download"
    | "delete"
    | "scanStorage"
    | "repairStorage"
    | "gcStorage"
  >
}

export interface AttachmentFileSystem {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>
  realpath(path: string): Promise<string>
  stat(path: string): Promise<{ isFile(): boolean; size: number }>
  assertReadable(path: string): Promise<void>
  createReadStream(path: string): ReturnType<typeof createReadStream>
  mkdtemp(prefix: string): Promise<string>
  writeFile(path: string, bytes: Uint8Array): Promise<void>
  rm(path: string, options: { recursive: true; force: true }): Promise<void>
}

export class DesktopAttachmentServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message)
    this.name = "DesktopAttachmentServiceError"
  }
}

export const SAFE_PREVIEW_MEDIA_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

export function serviceError(code: string): DesktopAttachmentServiceError {
  const messages: Record<string, string> = {
    attachment_source_expired: "文件授权已过期，请重新选择。",
    attachment_source_forbidden: "这个文件授权不属于当前窗口。",
    attachment_source_symlink: "暂不支持符号链接文件。",
    attachment_source_not_file: "只能添加普通文件，暂不支持文件夹。",
    attachment_source_unreadable: "无法读取这个文件。",
    attachment_file_too_large: "文件大小超过当前限制。",
    attachment_preview_unsupported: "这种文件不能直接预览。",
    attachment_preview_too_large: "图片太大，无法直接预览。",
    attachment_open_unavailable: "当前环境不能打开附件。",
    attachment_open_failed: "附件打开失败。",
    attachment_save_unavailable: "当前环境不能保存附件。",
    attachment_clipboard_unsupported: "剪贴板中的内容不是可上传的图片。",
    attachment_retry_unavailable: "这个附件已经不能重试，请重新添加。",
    attachment_task_exists: "附件上传任务重复。",
  }
  return new DesktopAttachmentServiceError(code, messages[code] ?? "附件操作失败。")
}

export function safeDisplayName(value: string): string {
  const printable = [...value]
    .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
    .join("")
  const safe = printable.replace(/[<>:"/\\|?*]/g, "_").trim()
  return safe || "attachment"
}
