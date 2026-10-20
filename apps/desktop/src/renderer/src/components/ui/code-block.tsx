"use client"

import { DEFAULT_THEMES, type FileContents } from "@pierre/diffs"
import { File as PierreFile, type FileOptions } from "@pierre/diffs/react"
import { Check, CodeXml, Copy } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useAppearance } from "@renderer/components/appearance/appearance-provider"
import { cn } from "@renderer/lib/utils"
import { CodeHighlightingProvider } from "./code-highlighting-provider"
import { BackgroundCode } from "./background-code"

// -- Styles --
// Injected once at runtime — ships as a single self-contained file with no
// modifications to globals.css required.

const CB_STYLES = `
.cbhl pierre-file::part(line){background-color:oklch(0.828 0.189 84.429/.12)}`

function injectStyles(): void {
  if (typeof document === "undefined") return
  if (document.getElementById("ss-code-block")) return
  const el = document.createElement("style")
  el.id = "ss-code-block"
  el.textContent = CB_STYLES
  document.head.appendChild(el)
}

// -- Types --

interface CodeBlockProps {
  variant?: "default" | "conversation"
  code: string
  language?: string
  filename?: string
  showLineNumbers?: boolean
  scrollable?: boolean
  maxHeight?: number
  highlightLines?: number[]
  /** Tailwind class(es) applied to the code body — e.g. "bg-muted", "bg-slate-950" */
  bodyClassName?: string
  className?: string
  /** 流式源码即时显示，语法着色在后台合并计算。 */
  streaming?: boolean
}

// -- Copy button --

function CopyBtn({ code }: { code: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    if (typeof window === "undefined" || !navigator?.clipboard) return
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }
  return (
    <button
      type="button"
      aria-label="Copy code"
      onClick={copy}
      className={cn(
        "-mr-1 ml-auto flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none",
        copied
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      {copied ? (
        <Check className="h-3 w-3" strokeWidth={3} />
      ) : (
        <Copy className="h-3 w-3" strokeWidth={2} />
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  )
}

// -- Internal code renderer --

interface FileCodeRendererProps {
  code: string
  language: string
  showLineNumbers: boolean
  scrollable: boolean
  maxHeight: number
  highlightLines?: number[]
  bodyClassName?: string
}

function FileCodeRenderer({
  code,
  language,
  showLineNumbers,
  scrollable,
  maxHeight,
  highlightLines,
  bodyClassName,
}: FileCodeRendererProps): React.JSX.Element {
  const { resolvedTheme: themeType } = useAppearance()
  const file = useMemo<FileContents>(
    () => ({
      name: codeBlockFilename(language),
      contents: code,
      lang: normalizeLanguage(language),
      cacheKey: `${language}:${code.length}:${hashCode(code)}`,
    }),
    [code, language]
  )
  const options = useMemo<FileOptions<undefined, undefined>>(
    () => ({
      disableFileHeader: true,
      disableLineNumbers: !showLineNumbers,
      overflow: "scroll",
      preferredHighlighter: "shiki-js",
      theme: DEFAULT_THEMES,
      themeType,
      tokenizeMaxLength: 220_000,
      tokenizeMaxLineLength: 20_000,
      unsafeCSS: `
        :host {
          display: block;
          min-width: max-content;
          --diffs-font-size: var(--code-font-size);
          --diffs-line-height: var(--code-line-height);
          --diffs-fg-number-override: var(--muted-foreground);
          --diffs-gap-style: 1px solid var(--border);
          background: transparent;
          color: var(--content-foreground);
          font-family: var(--font-mono);
          font-size: var(--code-font-size);
          line-height: var(--code-line-height);
        }

        pre {
          margin: 0;
          min-width: max-content;
          background: transparent !important;
          font-family: var(--font-mono) !important;
          font-size: var(--code-font-size) !important;
          line-height: var(--code-line-height) !important;
          white-space: pre;
          word-break: normal;
        }
      `,
    }),
    [showLineNumbers, themeType]
  )

  useEffect(() => {
    injectStyles()
  }, [])

  return (
    <div
      className={cn("overflow-x-auto", scrollable && "overflow-y-auto", bodyClassName)}
      style={scrollable ? { maxHeight: `${maxHeight}px` } : undefined}
    >
      <div className={cn(highlightLines?.length && "cbhl")}>
        <PierreFile file={file} options={options} />
      </div>
    </div>
  )
}

function codeBlockFilename(language: string): string {
  const extension = languageToExtension(language)
  return extension ? `snippet.${extension}` : "snippet.txt"
}

function normalizeLanguage(language: string): FileContents["lang"] | undefined {
  const normalized = language.trim().toLocaleLowerCase()
  if (!normalized || normalized === "text" || normalized === "txt" || normalized === "plain") {
    return undefined
  }
  const aliases: Record<string, string> = {
    bash: "shellscript",
    cjs: "javascript",
    h: "c",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    ps1: "powershell",
    py: "python",
    rb: "ruby",
    sh: "shellscript",
    ts: "typescript",
    tsx: "tsx",
    yml: "yaml",
  }
  return (aliases[normalized] ?? normalized) as FileContents["lang"]
}

function languageToExtension(language: string): string {
  const normalized = language.trim().toLocaleLowerCase()
  const extensions: Record<string, string> = {
    bash: "sh",
    javascript: "js",
    powershell: "ps1",
    python: "py",
    shellscript: "sh",
    typescript: "ts",
    yaml: "yml",
  }
  return (extensions[normalized] ?? normalized.replace(/[^a-z0-9_-]/g, "")) || "txt"
}

function hashCode(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return hash.toString(36)
}

// -- CodeBlock --

export function CodeBlock({
  variant = "default",
  code,
  language = "tsx",
  filename,
  showLineNumbers = false,
  scrollable = false,
  maxHeight = 400,
  highlightLines,
  bodyClassName,
  className,
  streaming = false,
}: CodeBlockProps): React.JSX.Element {
  return (
    <div
      data-streamdown={variant === "conversation" ? "code-block" : undefined}
      className={cn(
        "w-full overflow-hidden",
        variant === "default" && "rounded-xl border border-border bg-muted/40 shadow-sm",
        className
      )}
    >
      <div
        data-streamdown={variant === "conversation" ? "code-block-header" : undefined}
        className={cn(
          "flex min-w-0 items-center gap-2",
          variant === "default" && "h-11 border-b border-border px-4 text-[12.5px]"
        )}
      >
        <span className="inline-flex min-w-0 items-center gap-[7px]">
          <CodeXml className="size-[15px] shrink-0 text-muted-foreground" strokeWidth={1.8} />
          <span className="truncate font-mono leading-none text-foreground">
            {filename ?? language}
          </span>
        </span>
        <CopyBtn code={code} />
      </div>
      {variant === "conversation" ? (
        <CodeHighlightingProvider>
          <BackgroundCode
            code={code}
            language={normalizeLanguage(language) ?? "text"}
            streaming={streaming}
            className={cn(
              "overflow-x-auto px-[0.85rem] pt-[0.7rem] pb-[0.9rem] font-mono whitespace-pre",
              scrollable && "overflow-y-auto",
              bodyClassName
            )}
            style={{
              fontSize: "var(--code-font-size)",
              lineHeight: "var(--code-line-height)",
              maxHeight: scrollable ? maxHeight : undefined,
            }}
          />
        </CodeHighlightingProvider>
      ) : (
        <FileCodeRenderer
          code={code}
          language={language}
          showLineNumbers={showLineNumbers}
          scrollable={scrollable}
          maxHeight={maxHeight}
          highlightLines={highlightLines}
          bodyClassName={bodyClassName}
        />
      )}
    </div>
  )
}
