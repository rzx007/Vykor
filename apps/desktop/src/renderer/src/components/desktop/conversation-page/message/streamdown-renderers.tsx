import { FileCode2 } from "lucide-react"
import { isValidElement } from "react"
import { useIsCodeFenceIncomplete, type ExtraProps } from "streamdown"

import { CodeBlock } from "@renderer/components/ui/code-block"
import { cn } from "@renderer/lib/utils"

import { MermaidDiagram } from "./mermaid-diagram"

export function StreamdownCodeBlock({
  className,
  children,
}: React.HTMLAttributes<HTMLElement> & ExtraProps): React.JSX.Element {
  const isIncomplete = useIsCodeFenceIncomplete()
  const language = className?.match(/language-([^\s]+)/)?.[1] ?? ""
  const code = markdownNodeText(children).replace(/\n$/, "")

  if (language === "mermaid" || language === "mmd") {
    return <MermaidDiagram code={code} isIncomplete={isIncomplete} />
  }

  const codeType = language || "text"
  return (
    <CodeBlock
      className="my-4"
      code={code}
      language={codeType}
      filename={codeType}
      showLineNumbers={false}
    />
  )
}

export function FileButton({
  path,
  line,
  onOpenFile,
  children,
}: {
  path: string
  line?: number
  onOpenFile: (path: string, line?: number) => void
  children: React.ReactNode
}): React.JSX.Element {
  const sourceFile = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|swift|cs|vue|svelte)(?::\d+)?$/i.test(path)
  return (
    <button
      type="button"
      title={"\u6253\u5f00 " + path}
      onClick={() => onOpenFile(path, line)}
      className={cn(
        "assistant-file-link inline-flex max-w-full items-baseline gap-1 rounded-sm px-1 py-px align-baseline font-mono text-[0.9em] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        sourceFile && "assistant-file-link-source"
      )}
    >
      <FileReferenceIcon path={path} />
      <span className="truncate text-file-link underline-offset-2 hover:underline">{children}</span>
    </button>
  )
}

function markdownNodeText(value: React.ReactNode): string {
  if (value == null || typeof value === "boolean") return ""
  if (typeof value === "string" || typeof value === "number") return String(value)
  if (Array.isArray(value)) return value.map(markdownNodeText).join("")
  if (isValidElement(value)) {
    return markdownNodeText((value.props as { children?: React.ReactNode }).children)
  }
  return ""
}

function FileReferenceIcon({ path }: { path: string }): React.JSX.Element {
  const extension = path.split(".").pop()?.toLocaleLowerCase()
  const labels: Record<string, string> = {
    ts: "TS",
    tsx: "TS",
    js: "JS",
    jsx: "JS",
    py: "PY",
    md: "MD",
  }
  const label = extension ? labels[extension] : undefined
  if (!label)
    return <FileCode2 className="size-3.5 shrink-0 self-center text-file-link" strokeWidth={1.8} />
  return (
    <span aria-hidden="true" className="assistant-file-type self-center">
      {label}
    </span>
  )
}
