import type {
  DesktopAttachmentSessionPart,
  DesktopSessionPart,
} from "@shared/session-types"

export type AssistantContentUnit =
  | { id: string; type: "markdown"; text: string; phase?: "commentary" | "final_answer" }
  | { id: string; type: "reasoning"; text: string }
  | { id: string; type: "tool"; call: DesktopSessionPart; result?: DesktopSessionPart }
  | {
      id: string
      type: "image_generation"
      call: DesktopSessionPart
      hasAttachments: boolean
    }
  | { id: string; type: "attachments"; parts: DesktopAttachmentSessionPart[] }
  | {
      id: string
      type: "generated_attachments"
      parts: DesktopAttachmentSessionPart[]
      toolUseId: string
      ratio: ImageGenerationRatio
    }
  | { id: string; type: "error"; text: string }

export type ImageGenerationRatio =
  | "1:1"
  | "3:4"
  | "4:3"
  | "16:9"
  | "9:16"
  | "2:3"
  | "3:2"
  | "21:9"

export type FileReference = { path: string; line?: number }

export type ChangedFile = {
  path: string
  additions: number
  deletions: number
  hasStats: boolean
}

const mutationToolPattern =
  /(?:apply[_-]?patch|write|edit|create|delete|remove|move|rename|replace)/i
const pathKeys = new Set(["path", "file", "filePath", "file_path", "target", "destination"])

export function buildAssistantContent(parts: DesktopSessionPart[]): AssistantContentUnit[] {
  const units: AssistantContentUnit[] = []
  const results = new Map(
    parts
      .filter((part) => part.type === "tool_result" && part.toolUseId)
      .map((part) => [part.toolUseId as string, part])
  )
  const imageTools = new Map(
    parts
      .filter((part) => part.type === "tool" && part.toolName === "ImageGeneration")
      .map((part) => [part.toolUseId ?? part.id, part])
  )
  const generatedAttachmentToolIds = new Set(
    parts.flatMap((part) => {
      if (part.type !== "attachment") return []
      const toolUseId = generatedAttachmentToolUseId(part)
      return toolUseId ? [toolUseId] : []
    })
  )

  for (const part of parts) {
    if (part.type === "tool_result") continue
    if (part.type === "text" && part.text) {
      const previous = units.at(-1)
      if (previous?.type === "markdown") previous.text += part.text
      else if (part.text.trim()) {
        const phase = assistantPhase(part.metadata.phase)
        units.push({ id: part.id, type: "markdown", text: part.text, ...(phase ? { phase } : {}) })
      }
      continue
    }
    if (part.type === "reasoning" && part.text) {
      units.push({ id: part.id, type: "reasoning", text: part.text })
      continue
    }
    if (part.type === "attachment") {
      const previous = units.at(-1)
      const toolUseId = generatedAttachmentToolUseId(part)
      if (toolUseId) {
        if (previous?.type === "generated_attachments" && previous.toolUseId === toolUseId) {
          previous.parts.push(part)
        } else {
          units.push({
            id: part.id,
            type: "generated_attachments",
            parts: [part],
            toolUseId,
            ratio: normalizeImageGenerationRatio(imageTools.get(toolUseId)?.input?.ratio),
          })
        }
      } else if (previous?.type === "attachments") previous.parts.push(part)
      else units.push({ id: part.id, type: "attachments", parts: [part] })
      continue
    }
    if (part.type === "tool") {
      if (part.toolName === "ImageGeneration") {
        const toolUseId = part.toolUseId ?? part.id
        units.push({
          id: part.id,
          type: "image_generation",
          call: part,
          hasAttachments: generatedAttachmentToolIds.has(toolUseId),
        })
        continue
      }
      units.push({
        id: part.id,
        type: "tool",
        call: part,
        result: part.toolUseId ? results.get(part.toolUseId) : undefined,
      })
      continue
    }
    if (part.type === "error" || part.isError) {
      units.push({ id: part.id, type: "error", text: part.text || formatValue(part.output) })
    }
  }
  return units
}

export function normalizeImageGenerationRatio(value: unknown): ImageGenerationRatio {
  switch (value) {
    case "3:4":
    case "4:3":
    case "16:9":
    case "9:16":
    case "2:3":
    case "3:2":
    case "21:9":
      return value
    default:
      return "1:1"
  }
}

function generatedAttachmentToolUseId(
  part: DesktopAttachmentSessionPart
): string | undefined {
  if (part.metadata.source !== "image_generation") return undefined
  const toolUseId = part.metadata.toolUseId
  return typeof toolUseId === "string" && toolUseId.trim() ? toolUseId : undefined
}

function assistantPhase(value: unknown): "commentary" | "final_answer" | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined
}

export function parseFileReference(value: string): FileReference | null {
  const text = value.trim().replace(/^file:\/\//i, "")
  if (!text || /^(?:https?:|mailto:|#)/i.test(text) || text.startsWith("-")) return null
  const match = text.match(/^(.*?)(?::(\d+)(?::\d+)?)?$/)
  const path = (match?.[1]?.replace(/^[`'"]|[`'"]$/g, "") ?? text).replace(/^\/(?=[a-z]:[\\/])/i, "")
  const hasSeparator = /[\\/]/.test(path)
  const hasExtension = /(?:^|[\\/])[^\\/]+\.[a-z0-9]{1,12}$/i.test(path)
  if (!hasSeparator && !hasExtension) return null
  if (/\s/.test(path) && !/^[a-z]:[\\/]/i.test(path)) return null
  return { path, line: match?.[2] ? Number(match[2]) : undefined }
}

export function collectChangedFiles(parts: DesktopSessionPart[]): ChangedFile[] {
  const changes = new Map<string, ChangedFile>()
  for (const part of parts) {
    if (part.type !== "tool" || !mutationToolPattern.test(part.toolName ?? "")) continue
    const patch = findPatch(part.input)
    if (patch) collectPatchChanges(patch, changes)
    for (const path of collectPaths(part.input)) addChange(changes, path, 0, 0, false)
  }
  return [...changes.values()]
}

export function isTurnComplete(parts: DesktopSessionPart[]): boolean {
  return parts.every((part) => part.status !== "pending" && part.status !== "running")
}

export function summarizeToolCall(part: DesktopSessionPart): { name: string; detail?: string } {
  const rawName = part.toolName || "tool"
  const normalized = rawName.toLocaleLowerCase().replace(/[-_]/g, "")
  if (normalized === "imagetotext") return summarizeLocalOcr(part)
  const names: Array<[RegExp, string]> = [
    [/^(?:glob|listfiles|findfiles)/, "查找文件"],
    [/^(?:read|readfile)/, "读取文件"],
    [/^(?:write|writefile|createfile)/, "写入文件"],
    [/^(?:edit|editfile|replace)/, "编辑文件"],
    [/applypatch/, "应用补丁"],
    [/^(?:bash|shell|terminal|exec|command)/, "运行命令"],
    [/search/, "搜索内容"],
    [/browser|navigate|openurl/, "浏览网页"],
    [/fetch|http|request/, "请求网络"],
  ]
  const name = names.find(([pattern]) => pattern.test(normalized))?.[1] ?? humanizeToolName(rawName)
  return { name, detail: summarizeToolInput(part.input) }
}

export function toolDisplayName(call: DesktopSessionPart, result?: DesktopSessionPart): string {
  const rawName = call.toolName || "Tool"
  const normalized = rawName.toLocaleLowerCase().replace(/[-_]/g, "")
  if (!/^(?:bash|shell|exec|command)$/.test(normalized)) return rawName

  const metadata = result?.metadata ?? call.metadata
  if (typeof metadata.shellDisplayName === "string" && metadata.shellDisplayName.trim()) {
    return metadata.shellDisplayName
  }
  const dialect = metadata.shellDialect
  if (dialect === "powershell" || dialect === "windows-powershell") return "PowerShell"
  if (dialect === "pwsh") return "PowerShell 7"
  if (dialect === "cmd") return "Command Prompt"
  if (dialect === "bash") return "Bash"
  if (dialect === "posix" || dialect === "posix-sh" || dialect === "zsh") {
    const shell = metadata.shell
    return typeof shell === "string" && /bash/i.test(shell) ? "Bash" : "POSIX Shell"
  }
  return "Shell"
}

function summarizeLocalOcr(part: DesktopSessionPart): { name: string; detail?: string } {
  const metadata = recordValue(part.metadata.attachmentOcr)
  if (part.status === "failed" || part.isError) {
    if (part.metadata.failureKind === "command") {
      const imagePath = typeof part.input?.image_path === "string" ? part.input.image_path : ""
      if (imagePath.startsWith("attachment://")) {
        return { name: "本地 OCR 未能启动", detail: "图片引用无效，请重新发送图片后重试" }
      }
      return { name: "本地 OCR 未能启动", detail: "请重新发送消息后重试" }
    }
    return { name: "本地 OCR 提取失败", detail: "可以重新发送消息重试" }
  }
  if (metadata?.status === "no_text_detected") {
    return { name: "本地 OCR 未检测到文字", detail: "不能描述图片" }
  }
  if (metadata?.status === "completed") {
    return {
      name: "已使用本地 OCR 提取文字",
      ...(metadata.cached === true ? { detail: "已复用识别结果" } : {}),
    }
  }
  return { name: "正在使用本地 OCR 识别文字" }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function formatValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value == null) return ""
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function collectPaths(value: unknown): string[] {
  if (!value || typeof value !== "object") return []
  const paths: string[] = []
  for (const [key, child] of Object.entries(value)) {
    if (pathKeys.has(key) && typeof child === "string" && parseFileReference(child))
      paths.push(child)
    else if (child && typeof child === "object") paths.push(...collectPaths(child))
  }
  return paths
}

function summarizeToolInput(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined
  for (const key of [
    "path",
    "file_path",
    "filePath",
    "pattern",
    "query",
    "command",
    "cmd",
    "url",
    "cwd",
  ]) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return truncateSummary(value.trim())
  }
  const primitive = Object.values(input).find(
    (value): value is string | number | boolean =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  )
  return primitive === undefined ? undefined : truncateSummary(String(primitive))
}

function humanizeToolName(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim()
  return words ? words[0].toLocaleUpperCase() + words.slice(1) : "运行工具"
}

function truncateSummary(value: string): string {
  const oneLine = value.replace(/\s+/g, " ")
  return oneLine.length > 88 ? `${oneLine.slice(0, 85)}...` : oneLine
}

function findPatch(value: unknown): string | null {
  if (!value || typeof value !== "object") return null
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && /patch|diff/i.test(key)) return child
    if (child && typeof child === "object") {
      const nested = findPatch(child)
      if (nested) return nested
    }
  }
  return null
}

function collectPatchChanges(patch: string, changes: Map<string, ChangedFile>): void {
  let currentPath: string | null = null
  let additions = 0
  let deletions = 0
  const flush = (): void => {
    if (currentPath) addChange(changes, currentPath, additions, deletions, true)
    additions = 0
    deletions = 0
  }
  for (const line of patch.split(/\r?\n/)) {
    const header = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
    const gitHeader = line.match(/^\+\+\+ [ab]\/(.+)$/)
    if (header || gitHeader) {
      flush()
      currentPath = (header?.[1] ?? gitHeader?.[1] ?? "").trim()
    } else if (currentPath && line.startsWith("+") && !line.startsWith("+++")) additions += 1
    else if (currentPath && line.startsWith("-") && !line.startsWith("---")) deletions += 1
  }
  flush()
}

function addChange(
  changes: Map<string, ChangedFile>,
  rawPath: string,
  additions: number,
  deletions: number,
  hasStats: boolean
): void {
  const reference = parseFileReference(rawPath)
  if (!reference) return
  const existing = changes.get(reference.path)
  changes.set(reference.path, {
    path: reference.path,
    additions: (existing?.additions ?? 0) + additions,
    deletions: (existing?.deletions ?? 0) + deletions,
    hasStats: Boolean(existing?.hasStats || hasStats),
  })
}
