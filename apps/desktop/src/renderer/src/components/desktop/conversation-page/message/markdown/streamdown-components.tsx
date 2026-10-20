import type { ComponentProps } from "react"
import { Globe } from "lucide-react"
import { Streamdown } from "streamdown"
import { cn } from "@renderer/lib/utils"

import { parseFileReference } from "../message-render-model"
import { ConversationCodeBlock, FileButton, StreamdownCodeBlock } from "./streamdown-renderers"

const HTTP_LINK = /^https?:\/\//i

type StreamdownComponents = NonNullable<ComponentProps<typeof Streamdown>["components"]>

export function createStreamdownComponents({
  onOpenFile,
  codeBlockVariant = "default",
  fileLinkMode = "open",
}: {
  onOpenFile?: (path: string, line?: number) => void
  codeBlockVariant?: "default" | "conversation"
  fileLinkMode?: "open" | "text"
} = {}): StreamdownComponents {
  return {
    a: ({ href, children, ...props }) => {
      const file = href ? parseFileReference(href) : null
      if (file && fileLinkMode === "text") {
        return <span title={file.path}>{children}</span>
      }
      if (!file || !onOpenFile) {
        const isExternal = href ? HTTP_LINK.test(href) : false
        return (
          <a href={href} data-streamdown="link" {...props}>
            {isExternal ? (
              <Globe aria-hidden="true" className="mr-0.5 inline-block size-3.5 align-[-0.125em]" />
            ) : null}
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
    inlineCode: ({ children, className, ...props }) => {
      return (
        <code {...props} data-streamdown="inline-code" className={cn("font-mono", className)}>
          {children}
        </code>
      )
    },
    code: codeBlockVariant === "conversation" ? ConversationCodeBlock : StreamdownCodeBlock,
  }
}

export const streamdownComponents = createStreamdownComponents()
