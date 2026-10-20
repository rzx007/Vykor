import { Check, Copy, Download, TriangleAlert } from "lucide-react"
import { renderMermaidSVG } from "beautiful-mermaid"
import { useMemo, useState } from "react"

import { Spinner } from "@renderer/components/ui/spinner"

interface MermaidDiagramProps {
  code: string
  isIncomplete: boolean
}

export function MermaidDiagram({ code, isIncomplete }: MermaidDiagramProps): React.JSX.Element {
  const source = useMemo(() => code.trim(), [code])
  const [copiedSource, setCopiedSource] = useState<string | null>(null)
  const { svg, error } = useMemo(() => renderDiagram(source, isIncomplete), [isIncomplete, source])
  const copied = copiedSource === source

  const copySvg = async (): Promise<void> => {
    if (!svg) return
    await navigator.clipboard.writeText(svg)
    setCopiedSource(source)
    window.setTimeout(
      () => setCopiedSource((current) => (current === source ? null : current)),
      1400
    )
  }

  const downloadSvg = (): void => {
    if (!svg) return
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "diagram.svg"
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <figure className="assistant-mermaid group/mermaid">
      {svg ? (
        <>
          <div className="assistant-mermaid-controls">
            <button
              type="button"
              title={copied ? "Copied SVG" : "Copy SVG"}
              onClick={() => void copySvg()}
              className="assistant-mermaid-control"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </button>
            <button
              type="button"
              title="Download SVG"
              onClick={downloadSvg}
              className="assistant-mermaid-control"
            >
              <Download className="size-3.5" />
            </button>
          </div>
          <div className="assistant-mermaid-canvas" dangerouslySetInnerHTML={{ __html: svg }} />
        </>
      ) : error ? (
        <div className="assistant-mermaid-error">
          <div className="flex items-center gap-2 font-medium">
            <TriangleAlert className="size-4 shrink-0" />
            Mermaid render failed
          </div>
          <pre>{source}</pre>
          <p>{error}</p>
        </div>
      ) : (
        <div className="assistant-mermaid-loading">
          <Spinner />
          <span>Rendering diagram...</span>
        </div>
      )}
    </figure>
  )
}

function renderDiagram(
  source: string,
  isIncomplete: boolean
): { svg: string | null; error: string | null } {
  if (!source || isIncomplete) return { svg: null, error: null }
  try {
    return {
      svg: renderMermaidSVG(source, desktopMermaidTheme),
      error: null,
    }
  } catch (error) {
    return { svg: null, error: error instanceof Error ? error.message : String(error) }
  }
}

const desktopMermaidTheme = {
  accent: "var(--content-foreground)",
  bg: "var(--conversation)",
  border: "var(--input)",
  fg: "var(--content-foreground)",
  font: "Microsoft YaHei UI",
  line: "color-mix(in oklab, var(--content-foreground) 42%, var(--conversation))",
  muted: "color-mix(in oklab, var(--content-foreground) 58%, var(--conversation))",
  padding: 24,
  surface: "var(--card)",
  transparent: true,
} as const
