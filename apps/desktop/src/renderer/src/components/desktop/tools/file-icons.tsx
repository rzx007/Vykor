import {
  BookOpenText,
  File,
  FileArchive,
  FileBraces,
  FileCode2,
  FileImage,
  FileText,
  Settings,
  type LucideIcon,
} from "lucide-react"
import { WordFileIcon, ExcelFileIcon, PowerPointFileIcon, PdfFileIcon } from "./document-file-icons"

export type FileIconKind =
  | "archive"
  | "code"
  | "config"
  | "data"
  | "document"
  | "image"
  | "markdown"
  | "pdf"
  | "presentation"
  | "spreadsheet"
  | "text"
  | "unknown"

const codeExtensions = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "cjs",
  "cts",
  "go",
  "java",
  "js",
  "jsx",
  "kt",
  "lua",
  "mjs",
  "mts",
  "php",
  "py",
  "rb",
  "rs",
  "sh",
  "svelte",
  "swift",
  "ts",
  "tsx",
  "vue",
])

const configExtensions = new Set(["env", "ini", "toml", "xml", "yaml", "yml"])
const dataExtensions = new Set(["json", "jsonc", "jsonl", "lock", "sql"])
const documentExtensions = new Set(["doc", "docx", "odt", "rtf"])
const imageExtensions = new Set(["avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"])
const spreadsheetExtensions = new Set(["csv", "tsv", "xls", "xlsx", "ods"])
const archiveExtensions = new Set(["7z", "br", "gz", "rar", "tar", "tgz", "zip"])

const configFileNames = new Set([
  ".editorconfig",
  ".env",
  ".env.example",
  ".gitignore",
  ".npmrc",
  "dockerfile",
  "makefile",
])

export function getFileIcon(pathOrName: string, mediaType = ""): LucideIcon {
  if (getFileIconKind(pathOrName) === "unknown") {
    if (mediaType.startsWith("image/")) return FileImage
    if (/presentation|powerpoint/.test(mediaType)) return PowerPointFileIcon
    if (/sheet|excel/.test(mediaType)) return ExcelFileIcon
    if (mediaType.includes("pdf")) return PdfFileIcon
    if (/zip|compressed/.test(mediaType)) return FileArchive
    if (/word/.test(mediaType)) return WordFileIcon
    if (mediaType.startsWith("text/")) return FileText
  }
  switch (getFileIconKind(pathOrName)) {
    case "archive":
      return FileArchive
    case "code":
      return FileCode2
    case "config":
      return Settings
    case "data":
      return FileBraces
    case "document":
      return WordFileIcon
    case "pdf":
      return PdfFileIcon
    case "presentation":
      return PowerPointFileIcon
    case "image":
      return FileImage
    case "markdown":
      return BookOpenText
    case "spreadsheet":
      return ExcelFileIcon
    case "text":
      return FileText
    default:
      return File
  }
}

export function getFileIconKind(pathOrName: string): FileIconKind {
  const name = fileNameFromPath(pathOrName).toLowerCase()
  const extension = fileExtension(name)

  if (name.endsWith(".md") || name.endsWith(".mdx")) return "markdown"
  if (configFileNames.has(name) || configExtensions.has(extension)) return "config"
  if (dataExtensions.has(extension)) return "data"
  if (codeExtensions.has(extension)) return "code"
  if (extension === "pdf") return "pdf"
  if (["ppt", "pptx", "odp"].includes(extension)) return "presentation"
  if (documentExtensions.has(extension)) return "document"
  if (imageExtensions.has(extension)) return "image"
  if (spreadsheetExtensions.has(extension)) return "spreadsheet"
  if (archiveExtensions.has(extension)) return "archive"
  if (extension === "txt" || extension === "log") return "text"
  return "unknown"
}

export function isMarkdownPath(pathOrName: string): boolean {
  const name = fileNameFromPath(pathOrName).toLowerCase()
  return name.endsWith(".md") || name.endsWith(".mdx")
}

function fileNameFromPath(pathOrName: string): string {
  return pathOrName.split(/[\\/]/).filter(Boolean).pop() ?? pathOrName
}

function fileExtension(name: string): string {
  const parts = name.split(".")
  return parts.length > 1 ? (parts.pop() ?? "") : ""
}
