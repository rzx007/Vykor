import type { ServerCapabilities } from "@vykor/client"

type DesktopAttachmentLimits = NonNullable<ServerCapabilities["attachments"]>["limits"]

export interface DesktopAttachmentSupport {
  daemonSupported: boolean
  interactionEnabled: boolean
  uploadModes: readonly ("single" | "resumable")[]
  limits: DesktopAttachmentLimits | null
}

export interface DesktopAttachmentSupportEnvironment {
  isPackaged: boolean
  forceDisable: boolean
}

export const disabledDesktopAttachmentSupport: DesktopAttachmentSupport = {
  daemonSupported: false,
  interactionEnabled: false,
  uploadModes: [],
  limits: null,
}

export type DesktopAttachmentDraftStatus = "uploading" | "ready" | "failed" | "cancelled"

export interface DesktopAttachmentError {
  code: string
  message: string
  retryable: boolean
}

export interface DesktopAttachmentCandidate {
  draftId: string
  sourceToken: string
  displayName: string
  declaredMediaType: string
  sizeBytes: number
}

export interface DesktopAttachmentDraft {
  draftId: string
  taskId: string
  displayName: string
  declaredMediaType: string
  sizeBytes: number
  status: DesktopAttachmentDraftStatus
  bytesUploaded: number
  progress: number | null
  assetId?: string
  mediaType?: string
  error?: DesktopAttachmentError
}

export interface DesktopAttachmentCompatibility {
  supported: boolean
  reason?: string
}

const supportedTextExtensions = new Set([
  "txt", "text", "md", "mdx", "rst", "log", "csv", "tsv", "json", "jsonl",
  "ndjson", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties",
  "env", "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "css", "scss",
  "sass", "less", "html", "htm", "vue", "svelte", "py", "rb", "php", "java",
  "kt", "scala", "go", "rs", "c", "h", "cc", "cpp", "hpp", "cs", "swift",
  "dart", "lua", "pl", "r", "sql", "graphql", "sh", "bash", "zsh", "ps1",
  "bat", "cmd",
])
const documentExtensions = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
])
const archiveExtensions = new Set(["zip", "rar", "7z", "tar", "gz", "gzip", "tgz", "bz2", "xz"])

export function resolveDesktopAttachmentCompatibility(
  attachment: Pick<DesktopAttachmentDraft, "displayName" | "declaredMediaType" | "mediaType">
): DesktopAttachmentCompatibility {
  const mediaType = (attachment.mediaType ?? attachment.declaredMediaType)
    .split(";", 1)[0]!
    .trim()
    .toLowerCase()
  const name = attachment.displayName.trim().toLowerCase()
  const extension = name.includes(".") ? name.split(".").at(-1)! : ""
  if (mediaType.startsWith("image/")) return { supported: true }
  if (
    mediaType === "application/pdf" ||
    mediaType.includes("officedocument") ||
    mediaType.includes("msword") ||
    mediaType.includes("ms-excel") ||
    mediaType.includes("ms-powerpoint") ||
    documentExtensions.has(extension)
  ) {
    return { supported: false, reason: "暂不支持 PDF 和 Office 文档" }
  }
  if (
    mediaType.includes("zip") || mediaType.includes("rar") ||
    mediaType.includes("7z") || mediaType.includes("gzip") ||
    mediaType.includes("tar") || archiveExtensions.has(extension)
  ) {
    return { supported: false, reason: "暂不支持压缩包" }
  }
  if (
    mediaType.startsWith("text/") ||
    ["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/toml", "application/javascript", "application/typescript"].includes(mediaType) ||
    supportedTextExtensions.has(extension) ||
    ["readme", "license", "dockerfile", "makefile", ".gitignore"].includes(name)
  ) {
    return { supported: true }
  }
  return { supported: false, reason: "暂不支持这种二进制文件" }
}

export function areDesktopAttachmentsSendable(
  attachments: readonly DesktopAttachmentDraft[]
): boolean {
  return attachments.every(
    (attachment) =>
      attachment.status === "ready" &&
      resolveDesktopAttachmentCompatibility(attachment).supported
  )
}

export interface DesktopPromptAttachmentInput {
  assetId: string
  intent: DesktopAttachmentIntent
  displayName: string
}

export type DesktopAttachmentIntent =
  "auto" | "vision" | "ocr" | "document" | "tool_resource" | "workspace_reference"

export interface StartDesktopAttachmentUploadInput {
  draftId: string
  taskId: string
  sourceToken: string
}

export interface UploadDesktopAttachmentMemoryInput {
  draftId: string
  taskId: string
  bytes: ArrayBuffer
  displayName: string
  mediaType: string
}

export interface RetryDesktopAttachmentUploadInput {
  draftId: string
  taskId: string
}

export interface DiscardDesktopAttachmentDraftInput {
  draftId: string
}

export interface CancelDesktopAttachmentUploadInput {
  taskId: string
}

export interface DesktopAttachmentAssetInput {
  assetId: string
}

export interface DesktopAttachmentPreview {
  bytes: ArrayBuffer
  mediaType: string
}

interface DesktopAttachmentUploadEventBase {
  draftId: string
  taskId: string
}

export type DesktopAttachmentUploadEvent =
  | (DesktopAttachmentUploadEventBase & {
      type: "progress"
      bytesRead: number
      totalBytes: number
    })
  | (DesktopAttachmentUploadEventBase & {
      type: "success"
      assetId: string
      displayName: string
      mediaType: string
      sizeBytes: number
    })
  | (DesktopAttachmentUploadEventBase & {
      type: "failed"
      error: DesktopAttachmentError
    })
  | (DesktopAttachmentUploadEventBase & {
      type: "cancelled"
    })

export function resolveDesktopAttachmentSupport(
  capabilities: ServerCapabilities,
  environment: DesktopAttachmentSupportEnvironment
): DesktopAttachmentSupport {
  const daemonSupported =
    (capabilities.features["attachments"] ?? 0) >= 1 && Boolean(capabilities.attachments)
  if (daemonSupported && capabilities.attachments) {
    return {
      daemonSupported: true,
      interactionEnabled: !environment.forceDisable,
      uploadModes: capabilities.attachments.uploadModes,
      limits: capabilities.attachments.limits,
    }
  }
  return { ...disabledDesktopAttachmentSupport }
}

export function normalizeDesktopAttachmentSupport(
  support: DesktopAttachmentSupport | null | undefined
): DesktopAttachmentSupport {
  return support ?? disabledDesktopAttachmentSupport
}
