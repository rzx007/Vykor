import { getFiletypeFromFileName, type FileContents } from "@pierre/diffs"

import type { WorkspaceReadFileResult } from "@shared/workspace-types"

const codeLineHeight = 20
const codeScrollOffset = 72

export function createPreviewFile(preview: WorkspaceReadFileResult): FileContents {
  return {
    name: preview.path,
    contents: preview.content ?? "",
    lang: normalizeLanguage(preview.language, preview.path),
    cacheKey: `${preview.path}:${preview.size}`,
  }
}

export function resolvePreviewScrollTop({
  searchLine,
  targetLine,
}: {
  searchLine?: number
  targetLine?: number
}): number | null {
  const lineIndex = searchLine ?? (targetLine ? targetLine - 1 : null)
  return lineIndex === null ? null : Math.max(0, lineIndex * codeLineHeight - codeScrollOffset)
}

export function resolveActiveLineIndex({
  searchLine,
  targetLine,
}: {
  searchLine?: number
  targetLine?: number
}): number | null {
  return searchLine ?? (targetLine ? targetLine - 1 : null)
}

function normalizeLanguage(language: string, path: string): FileContents["lang"] | undefined {
  const exact = getFiletypeFromFileName(path)
  const inferred = exact === "text" ? getFiletypeFromFileName(path.toLowerCase()) : exact
  if (inferred !== "text") return inferred
  const normalized = language.toLowerCase()

  const languageMap: Record<string, FileContents["lang"]> = {
    bash: "bash",
    c: "c",
    cc: "cpp",
    cjs: "javascript",
    cpp: "cpp",
    cs: "csharp",
    csharp: "csharp",
    css: "css",
    cts: "typescript",
    dockerfile: "docker",
    go: "go",
    html: "html",
    java: "java",
    js: "javascript",
    json: "json",
    jsonc: "jsonc",
    jsx: "jsx",
    kt: "kotlin",
    less: "less",
    lua: "lua",
    md: "markdown",
    mdx: "mdx",
    mjs: "javascript",
    mts: "typescript",
    php: "php",
    py: "python",
    rb: "ruby",
    rs: "rust",
    scss: "scss",
    sh: "bash",
    sql: "sql",
    svelte: "svelte",
    swift: "swift",
    toml: "toml",
    ts: "typescript",
    tsx: "tsx",
    vue: "vue",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    zsh: "bash",
  }

  return languageMap[normalized] ?? "text"
}
