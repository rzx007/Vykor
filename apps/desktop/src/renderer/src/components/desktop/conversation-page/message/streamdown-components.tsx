import type { ComponentProps } from "react"
import { Streamdown } from "streamdown"

import { parseFileReference, parseInlineFileReference } from "./message-render-model"
import { FileButton, StreamdownCodeBlock } from "./streamdown-renderers"

type StreamdownComponents = NonNullable<ComponentProps<typeof Streamdown>["components"]>

export function createStreamdownComponents({
  onOpenFile,
}: {
  onOpenFile?: (path: string, line?: number) => void
} = {}): StreamdownComponents {
  return {
    a: ({ href, children, ...props }) => {
      const file = href ? parseFileReference(href) : null
      if (!file || !onOpenFile) {
        return (
          <a href={href} data-streamdown="link" {...props}>
            {children}
          </a>
        )
      }
      return (
        <FileButton path={file.path} line={file.line} onOpenFile={onOpenFile}>
          {children}
        </FileButton>
      )
    },
    inlineCode: ({ children, ...props }) => {
      const value = String(children).replace(/\n$/, "")
      const file = parseInlineFileReference(value)
      if (!file || !onOpenFile) {
        return (
          <code className="text-ui-small rounded-md bg-input/80 px-1.5 py-0.5" {...props}>
            {children}
          </code>
        )
      }
      return (
        <FileButton path={file.path} line={file.line} onOpenFile={onOpenFile}>
          {children}
        </FileButton>
      )
    },
    code: StreamdownCodeBlock,
  }
}

export const streamdownComponents = createStreamdownComponents()
