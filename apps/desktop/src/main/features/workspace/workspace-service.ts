import { readdir, readFile, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, extname, join, posix, relative, resolve, sep, win32 } from "node:path"
import { clipboard, shell } from "electron"

import type {
  WorkspaceCopyPathInput,
  WorkspaceFileEntry,
  WorkspaceFileScope,
  WorkspaceListFilesInput,
  WorkspaceListFilesResult,
  WorkspaceReadFileInput,
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
    const resolved = await this.resolveAllowedFile(input.rootPath, input.path)
    const info = await stat(resolved.absolutePath)
    if (!info.isFile()) throw new Error("只能预览文件。")

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
      this.allowedRoots?.configDir ??
      process.env.OPENHARNESS_CONFIG_DIR ??
      join(homedir(), ".openharness-ts")
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
