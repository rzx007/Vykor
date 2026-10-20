import { randomUUID } from "node:crypto"
import { open, readdir, readFile, realpath, rename, stat, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, extname, join, posix, relative, resolve, sep, win32 } from "node:path"
import { clipboard, shell } from "electron"
import { documentFormat, MAX_DOCUMENT_PREVIEW_BYTES } from "../../../shared/document-preview"
import { desktopSessionService } from "../session/session-service"

import type {
  WorkspaceCopyPathInput,
  WorkspaceFileEntry,
  WorkspaceFileScope,
  WorkspaceListFilesInput,
  WorkspaceListFilesResult,
  WorkspaceReadFileInput,
  WorkspaceWriteFileInput,
  WorkspaceReadFileResult,
  WorkspaceRevealPathInput,
} from "../../../shared/workspace-types"
import {
  safeImageMediaTypeFromName,
  type SafeImageMediaType,
} from "../../../shared/safe-image-preview"
import { evaluateInspectedImagePreview } from "../image-preview/inspect-safe-image-layout"

import { buildOutsideProjectRoot } from "../session/outside-project-workspace"
import {
  classifyWorkspacePath,
  stillInsideAllowedRoot,
  type WorkspaceAllowedRoots,
  type WorkspacePathClassification,
} from "./workspace-path"

const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vite",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
])
const maxTextFileBytes = 1_250_000
export const maxImagePreviewBytes = 50 * 1024 * 1024
const textDecoder = new TextDecoder("utf-8", { fatal: false })

class WorkspaceService {
  private allowedRoots: { configDir: string; documentsPath: string } | null = null
  private savingPaths = new Set<string>()

  configureAllowedRoots(input: { configDir: string; documentsPath: string }): void {
    this.allowedRoots = input
  }

  async listFiles(input: WorkspaceListFilesInput): Promise<WorkspaceListFilesResult> {
    const rootPath = await resolveDirectory(input.rootPath)
    const entries: WorkspaceFileEntry[] = []

    const visit = async (directory: string): Promise<void> => {
      const children = await readdir(directory, { withFileTypes: true })
      children.sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1
        return left.name.localeCompare(right.name)
      })

      for (const child of children) {
        if (child.name.startsWith(".") && ignoredDirectories.has(child.name)) continue
        if (child.isDirectory() && ignoredDirectories.has(child.name)) continue
        if (child.isSymbolicLink()) continue

        const absolutePath = resolve(directory, child.name)
        const relativePath = toRelativeProjectPath(rootPath, absolutePath)

        if (child.isDirectory()) {
          entries.push({ path: `${relativePath}/`, type: "directory" })
          await visit(absolutePath)
          continue
        }

        if (child.isFile()) {
          let size: number | undefined
          try {
            size = (await stat(absolutePath)).size
          } catch {
            size = undefined
          }
          entries.push({ path: relativePath, type: "file", size })
        }
      }
    }

    await visit(rootPath)
    return { rootPath, entries }
  }

  async readFile(input: WorkspaceReadFileInput): Promise<WorkspaceReadFileResult> {
    if (input.path.startsWith("attachment://")) return await this.readDocumentAttachment(input)
    const resolved = await this.resolveAllowedFile(input.rootPath, input.path)
    const info = await stat(resolved.absolutePath)
    if (!info.isFile()) throw new Error("只能预览文件。")
    const format = documentFormat(resolved.absolutePath)
    if (format) {
      if (info.size > MAX_DOCUMENT_PREVIEW_BYTES) throw new Error("文档超过 64 MB，无法直接预览。")
      const bytes = await readFile(resolved.absolutePath)
      if (bytes.byteLength > MAX_DOCUMENT_PREVIEW_BYTES)
        throw new Error("文档超过 64 MB，无法直接预览。")
      return {
        ...toReadResult(resolved.classification, info.size, true, null),
        documentPreview: { format, bytes: exactArrayBuffer(bytes) },
      }
    }

    const imageMediaType = safeImageMediaTypeFromName(resolved.absolutePath)
    if (imageMediaType) {
      if (info.size > maxImagePreviewBytes) {
        return toReadResult(resolved.classification, info.size, true, null, {
          previewBytes: null,
          mediaType: imageMediaType,
          imagePreviewError: "image_too_large",
        })
      }

      const buffer = await readFile(resolved.absolutePath)
      if (buffer.byteLength > maxImagePreviewBytes) {
        return toReadResult(resolved.classification, buffer.byteLength, true, null, {
          previewBytes: null,
          mediaType: imageMediaType,
          imagePreviewError: "image_too_large",
        })
      }

      const decision = await evaluateInspectedImagePreview(buffer, imageMediaType)
      if (!decision.ok) {
        return toReadResult(resolved.classification, buffer.byteLength, true, null, {
          previewBytes: null,
          mediaType: decision.error === "image_too_large" ? imageMediaType : null,
          imagePreviewError: decision.error,
        })
      }

      return toReadResult(resolved.classification, buffer.byteLength, true, null, {
        previewBytes: exactArrayBuffer(buffer),
        mediaType: decision.mediaType,
        imagePreviewError: null,
      })
    }

    if (info.size > maxTextFileBytes) {
      return toReadResult(resolved.classification, info.size, true, null)
    }

    const buffer = await readFile(resolved.absolutePath)
    const binary = isLikelyBinary(buffer)
    return toReadResult(
      resolved.classification,
      info.size,
      binary,
      binary ? null : textDecoder.decode(buffer)
    )
  }

  async writeFile(input: WorkspaceWriteFileInput): Promise<WorkspaceReadFileResult> {
    if (typeof input.content !== "string" || typeof input.originalContent !== "string")
      throw new Error("保存内容必须是文本。")
    const contentBytes = Buffer.from(input.content, "utf8")
    if (contentBytes.byteLength > maxTextFileBytes) throw new Error("文件过大，无法在此编辑。")
    const resolved = await this.resolveAllowedFile(input.rootPath, input.path)
    if (resolved.classification.kind !== "project") throw new Error("只能编辑当前项目内的文件。")
    const pathKey =
      process.platform === "win32" ? resolved.absolutePath.toLowerCase() : resolved.absolutePath
    if (this.savingPaths.has(pathKey)) throw new Error("文件正在保存，请稍后重试。")
    this.savingPaths.add(pathKey)
    let temporaryPath: string | undefined
    try {
      // 不使用截断方式打开：先确认磁盘内容仍等于开始编辑时的内容。
      const handle = await open(resolved.absolutePath, "r+")
      let sourceClosed = false
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size > maxTextFileBytes)
          throw new Error("文件过大或不是文本文件。")
        const current = await handle.readFile()
        if (current.byteLength > maxTextFileBytes || isLikelyBinary(current))
          throw new Error("只能编辑 UTF-8 文本文件。")
        let original: string
        try {
          original = new TextDecoder("utf-8", { fatal: true }).decode(current)
        } catch {
          throw new Error("只能编辑 UTF-8 文本文件。")
        }
        if (original !== input.originalContent)
          throw new Error("文件已被其他程序修改，请重新打开文件后合并改动。草稿仍已保留。")
        const hasBom = current[0] === 0xef && current[1] === 0xbb && current[2] === 0xbf
        const bytes = hasBom
          ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), contentBytes])
          : contentBytes
        if (bytes.length > maxTextFileBytes) throw new Error("文件过大，无法在此编辑。")
        temporaryPath = join(dirname(resolved.absolutePath), `.vykor-save-${randomUUID()}.tmp`)
        const temporary = await open(temporaryPath, "wx", info.mode & 0o777)
        try {
          let written = 0
          while (written < bytes.length) {
            const part = await temporary.write(bytes, written, bytes.length - written, written)
            if (part.bytesWritten === 0) throw new Error("文件写入失败。")
            written += part.bytesWritten
          }
          if (process.platform !== "win32") await temporary.chmod(info.mode & 0o777)
          await temporary.sync()
        } finally {
          await temporary.close()
        }
        // Windows 不允许替换仍被当前进程以写入模式打开的源文件。
        await handle.close()
        sourceClosed = true
        // 完整写入后再替换；写入失败不会破坏源文件，准备期间的外部修改也不能覆盖。
        const latest = await stat(resolved.absolutePath)
        if (
          latest.dev !== info.dev ||
          latest.ino !== info.ino ||
          latest.size !== info.size ||
          latest.mtimeMs !== info.mtimeMs ||
          latest.ctimeMs !== info.ctimeMs ||
          !current.equals(await readFile(resolved.absolutePath))
        )
          throw new Error("文件已被其他程序修改，请重新打开文件后合并改动。草稿仍已保留。")
        await rename(temporaryPath, resolved.absolutePath)
        temporaryPath = undefined
        return toReadResult(resolved.classification, bytes.length, false, input.content)
      } finally {
        if (!sourceClosed) await handle.close()
      }
    } finally {
      this.savingPaths.delete(pathKey)
      if (temporaryPath) await unlink(temporaryPath).catch(() => undefined)
    }
  }

  async revealPath(input: WorkspaceRevealPathInput): Promise<void> {
    const resolved = await this.resolveAllowedFile(input.rootPath, input.path)
    const info = await stat(resolved.absolutePath)

    if (info.isDirectory()) {
      const error = await shell.openPath(resolved.absolutePath)
      if (error) throw new Error(error)
      return
    }

    shell.showItemInFolder(resolved.absolutePath)
  }

  private async readDocumentAttachment(
    input: WorkspaceReadFileInput
  ): Promise<WorkspaceReadFileResult> {
    const match = input.path.match(/^attachment:\/\/([^/]+)\//)
    if (!match) throw new Error("无效附件引用。")
    const assetId = decodeURIComponent(match[1]!)
    const client = await desktopSessionService.daemonClient()
    const asset = await client.attachments.get(assetId)
    if (
      !documentFormat(asset.displayName) ||
      asset.status !== "ready" ||
      !asset.sizeBytes ||
      asset.sizeBytes > MAX_DOCUMENT_PREVIEW_BYTES
    )
      throw new Error("附件不是可预览的文档或超过 64 MB。")
    const response = await client.attachments.download(assetId)
    if (!response.body) throw new Error("无法读取附件。")
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        total += part.value.byteLength
        if (total > MAX_DOCUMENT_PREVIEW_BYTES) throw new Error("附件超过 64 MB。")
        chunks.push(part.value)
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    const bytes = Buffer.concat(chunks)
    return {
      path: input.path,
      name: asset.displayName,
      size: bytes.length,
      binary: true,
      content: null,
      language: "",
      scope: "project",
      relativePath: input.path,
      rootLabel: "会话附件",
      previewBytes: null,
      mediaType: null,
      imagePreviewError: null,
      documentPreview: {
        format: documentFormat(asset.displayName)!,
        bytes: exactArrayBuffer(bytes),
      },
    }
  }

  async copyPath(input: WorkspaceCopyPathInput): Promise<string> {
    const resolved = await this.resolveAllowedFile(input.rootPath, input.path)
    const text = input.absolute ? resolved.absolutePath : resolved.classification.relativePath
    clipboard.writeText(text)
    return text
  }

  private async resolveAllowedFile(
    projectRoot: string,
    rawPath: string
  ): Promise<{ absolutePath: string; classification: WorkspacePathClassification }> {
    const rootPath = await resolveDirectory(projectRoot)
    const classification = classifyWorkspacePath(rawPath, this.rootsFor(rootPath), { win32, posix })
    if (!classification) throw new Error("文件必须位于当前项目目录内。")

    const candidate =
      classification.kind === "project"
        ? join(rootPath, ...classification.relativePath.split("/"))
        : classification.tabPath.replace(/\//g, sep)
    let absolutePath: string
    try {
      absolutePath = await realpath(candidate)
    } catch {
      throw new Error("无法预览。")
    }

    if (
      !stillInsideAllowedRoot(absolutePath, classification, rootPath, this.rootsFor(rootPath), {
        win32,
        posix,
      })
    ) {
      throw new Error("文件必须位于当前项目目录内。")
    }
    return { absolutePath, classification }
  }

  allowedRootsFor(projectRoot: string): WorkspaceAllowedRoots {
    return this.rootsFor(projectRoot)
  }

  private rootsFor(projectRoot: string): WorkspaceAllowedRoots {
    const configDir =
      this.allowedRoots?.configDir ?? process.env.VYKOR_CONFIG_DIR ?? join(homedir(), ".vykor")
    const documentsPath = this.allowedRoots?.documentsPath ?? ""
    return {
      projectRoot,
      configDir,
      skillsDir: join(configDir, "skills"),
      userProfilePath: join(configDir, "USER.md"),
      outsideProjectRoot: documentsPath ? buildOutsideProjectRoot(documentsPath) : "",
    }
  }
}

function toRelativeProjectPath(rootPath: string, absolutePath: string): string {
  return relative(rootPath, absolutePath).split(sep).join("/")
}

async function resolveDirectory(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value.trim()) throw new Error("项目路径不能为空。")
  const path = resolve(value)
  const info = await stat(path)
  if (!info.isDirectory()) throw new Error("项目路径不是目录。")
  return path
}

function isLikelyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_000))
  return sample.includes(0)
}

function toReadResult(
  classification: WorkspacePathClassification,
  size: number,
  binary: boolean,
  content: string | null,
  imagePreview: {
    previewBytes: ArrayBuffer | null
    mediaType: SafeImageMediaType | null
    imagePreviewError: WorkspaceReadFileResult["imagePreviewError"]
  } = {
    previewBytes: null,
    mediaType: null,
    imagePreviewError: null,
  }
): WorkspaceReadFileResult {
  return {
    path: classification.tabPath,
    name: basename(classification.tabPath),
    language: languageFromPath(classification.tabPath),
    size,
    binary,
    content,
    scope: classification.kind as WorkspaceFileScope,
    relativePath: classification.relativePath,
    rootLabel: classification.rootLabel,
    ...imagePreview,
  }
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function languageFromPath(path: string): string {
  const extension = extname(path).toLowerCase()
  switch (extension) {
    case ".cjs":
    case ".js":
    case ".mjs":
      return "javascript"
    case ".cts":
    case ".mts":
    case ".ts":
      return "typescript"
    case ".tsx":
      return "tsx"
    case ".jsx":
      return "jsx"
    case ".css":
      return "css"
    case ".html":
      return "html"
    case ".json":
      return "json"
    case ".md":
    case ".mdx":
      return "markdown"
    case ".py":
      return "python"
    case ".rs":
      return "rust"
    case ".go":
      return "go"
    case ".java":
      return "java"
    case ".yml":
    case ".yaml":
      return "yaml"
    default:
      return extension.slice(1) || "text"
  }
}

export const workspaceService = new WorkspaceService()
