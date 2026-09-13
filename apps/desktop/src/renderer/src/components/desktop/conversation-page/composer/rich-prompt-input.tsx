import { LexicalComposer } from "@lexical/react/LexicalComposer"
import { ContentEditable } from "@lexical/react/LexicalContentEditable"
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary"
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin"
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin"
import { useMemo, useState } from "react"

import { cn } from "@renderer/lib/utils"
import type { ComposerDocument } from "@renderer/stores/desktop-session/composer-document"
import type { ComposerPickerCommand, ComposerPickerItem } from "./composer-picker"
import type { ContextPickerItem } from "./context-picker"
import { ComposerClipboardPlugin } from "./composer-clipboard-plugin"
import { SyncDraftPlugin } from "./composer-lexical-document"
import { ComposerPickerPlugin } from "./composer-picker-plugin"
import { ComposerSubmitPlugin } from "./composer-submit-plugin"
import type { ComposerSkill } from "./composer-types"
import { ResourceMentionNode } from "./resource-mention-node"
import { SkillMentionNode } from "./skill-mention-node"
import { PluginMentionNode } from "./plugin-mention-node"

export type { ComposerSkill } from "./composer-types"
export { composerDocumentFromLexical, restoreComposerDocument } from "./composer-lexical-document"
export {
  executeComposerCommand,
  insertSkillMention,
  triggerFromEditorState,
} from "./composer-picker-plugin"

export function RichPromptInput({
  id,
  value,
  rows,
  placeholder,
  disabled,
  skills = [],
  commands = [],
  className,
  onChange,
  onSubmit,
  onCommand = async () => undefined,
  onPasteFiles,
  contextItems = [],
  contextPickerRequest = 0,
  contextPickerOpen = false,
  onContextAction,
  onContextPickerOpenChange,
}: {
  id: string
  value: ComposerDocument
  rows: number
  placeholder: string
  disabled: boolean
  skills?: readonly ComposerSkill[]
  commands?: readonly ComposerPickerItem[]
  className?: string
  onChange: (value: ComposerDocument) => void
  onSubmit: () => void
  onCommand?: (command: ComposerPickerCommand) => Promise<void>
  onPasteFiles?: (files: readonly File[]) => void
  contextItems?: readonly ContextPickerItem[]
  contextPickerRequest?: number
  contextPickerOpen?: boolean
  onContextAction?: (item: ContextPickerItem) => void
  onContextPickerOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const [isComposing, setIsComposing] = useState(false)
  const [commandError, setCommandError] = useState<string | null>(null)
  const minHeight = `${Math.max(rows, 1) * 24 + 24}px`
  const initialConfig = useMemo(
    () => ({
      namespace: `DesktopComposer:${id}`,
      theme: {
        paragraph: "m-0",
        text: {
          bold: "font-semibold",
          italic: "italic",
          underline: "underline",
          strikethrough: "line-through",
        },
      },
      onError(error: Error) {
        console.error(error)
      },
      nodes: [SkillMentionNode, ResourceMentionNode, PluginMentionNode],
    }),
    [id]
  )

  return (
    <LexicalComposer key={id} initialConfig={initialConfig}>
      <div
        className={cn("relative", disabled && "pointer-events-none opacity-60")}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
      >
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              id={id}
              aria-label="输入对话内容"
              aria-multiline="true"
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              className={cn(
                "text-ui-small block max-h-44 min-h-18 w-full overflow-y-auto bg-transparent px-4 pt-3 leading-6 break-words whitespace-pre-wrap text-foreground outline-none",
                "**:text-inherit empty:before:content-none focus-visible:outline-none",
                className
              )}
              style={{ minHeight }}
            />
          }
          placeholder={
            <RichPromptPlaceholder
              placeholder={placeholder}
              className={cn(className?.includes("pt-4") && "top-4")}
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <ComposerClipboardPlugin onPasteFiles={onPasteFiles} skills={skills} />
        <SyncDraftPlugin value={value} onChange={onChange} />
        <ComposerPickerPlugin
          skills={skills}
          commands={commands}
          contextItems={contextItems}
          contextPickerRequest={contextPickerRequest}
          contextPickerOpen={contextPickerOpen}
          onContextAction={onContextAction}
          onContextPickerOpenChange={onContextPickerOpenChange}
          onCommand={onCommand}
          onCommandError={setCommandError}
        />
        {!isComposing && !disabled ? <ComposerSubmitPlugin onSubmit={onSubmit} /> : null}
        {commandError ? (
          <p role="alert" className="px-4 text-sm text-destructive">
            {commandError}
          </p>
        ) : null}
      </div>
    </LexicalComposer>
  )
}

function RichPromptPlaceholder({
  placeholder,
  className,
}: {
  placeholder: string
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "text-ui-small pointer-events-none absolute top-3 left-4 leading-6 text-placeholder/65",
        className
      )}
    >
      {placeholder}
    </div>
  )
}
