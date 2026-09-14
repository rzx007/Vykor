import {
  Check,
  Box,
  ChevronDown,
  ChevronUp,
  Copy,
  GitBranchPlus,
  PencilLine,
  ShieldCheck,
  X,
} from "lucide-react"
import { useEffect, useState } from "react"

import { messageTextContent } from "./message-content"
import { AssistantMessage } from "./assistant-message"
import { formatMessageTime } from "./format-message-time"
import { Button } from "@renderer/components/ui/button"
import { AttachmentGroup } from "@renderer/components/ui/attachment"
import { Message, MessageContent } from "@renderer/components/ui/message"
import { cn } from "@renderer/lib/utils"
import type {
  DesktopPermissionRequest,
  DesktopAttachmentSessionPart,
  DesktopSessionMessage,
  DesktopSessionPart,
  SessionUserInputItem,
} from "@shared/session-types"
import { MessageAttachment } from "./message-attachment"
import { RichPromptInput } from "../composer/rich-prompt-input"
import {
  composerDocument,
  selectComposerDocumentText,
  type ComposerDocument,
} from "@renderer/stores/desktop-session/composer-document"
import { ModelSwitchDivider, readModelSwitchPresentation } from "./model-switch-divider"
import {
  ContextCompactionDivider,
  readContextCompactionPresentation,
} from "./context-compaction-divider"

const collapsibleUserMessageChars = 900
const collapsibleUserMessageLines = 14

export function MessageBlock({
  message,
  parts,
  inputItems,
  streaming,
  userActions,
  onOpenFile,
  canOpenReview,
  onOpenReview,
  onOpenTerminal,
}: {
  message: DesktopSessionMessage
  parts: DesktopSessionPart[]
  inputItems?: SessionUserInputItem[]
  streaming: boolean
  userActions?: {
    canEdit: boolean
    onEdit: (document: ComposerDocument) => void
  }
  onOpenFile: (path: string, line?: number) => void
  canOpenReview: boolean
  onOpenReview: (path?: string) => void
  onOpenTerminal: (terminalId: string) => void
}): React.JSX.Element {
  if (message.role === "user") {
    const content = messageTextContent(parts)
    const items = readUserItems(parts)
    const attachmentParts = parts
      .filter((part): part is DesktopAttachmentSessionPart => part.type === "attachment")
      .sort((left, right) => left.seq - right.seq)
    return (
      <UserMessageBlock
        content={content}
        items={items}
        document={composerDocument(
          inputItems ??
            parts.flatMap((part) =>
              part.type === "text" && Array.isArray(part.metadata.items)
                ? (part.metadata.items as SessionUserInputItem[])
                : []
            )
        )}
        attachmentParts={attachmentParts}
        timestamp={message.updatedAt}
        userActions={userActions}
      />
    )
  }

  if (message.role === "system") {
    const modelSwitch = readModelSwitchPresentation(message.metadata)
    if (modelSwitch) return <ModelSwitchDivider presentation={modelSwitch} />
    const compaction = readContextCompactionPresentation(message.metadata)
    if (compaction) return <ContextCompactionDivider presentation={compaction} />
    const content = parts.map((part) => part.text ?? "").join("")
    return <p className="text-xs whitespace-pre-wrap text-ui-muted">{content}</p>
  }

  return (
    <AssistantMessage
      parts={parts}
      streaming={streaming}
      onOpenFile={onOpenFile}
      canOpenReview={canOpenReview}
      onOpenReview={onOpenReview}
      onOpenTerminal={onOpenTerminal}
    />
  )
}

function UserMessageBlock({
  content,
  items,
  document,
  attachmentParts,
  timestamp,
  userActions,
}: {
  content: string
  items: UserDisplayItem[]
  document: ComposerDocument
  attachmentParts: DesktopAttachmentSessionPart[]
  timestamp: number
  userActions?: { canEdit: boolean; onEdit: (document: ComposerDocument) => void }
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(document)
  const canEdit = Boolean(userActions?.canEdit && (content.trim() || attachmentParts.length > 0))
  const containsImage = attachmentParts.some((part) => part.mediaType.startsWith("image/"))
  const containsFile = attachmentParts.some((part) => !part.mediaType.startsWith("image/"))
  const alignMixedAttachmentHeights = containsImage && containsFile

  useEffect(() => {
    if (editing) return
    const timer = window.setTimeout(() => setDraft(document), 0)
    return () => window.clearTimeout(timer)
  }, [document, editing])

  if (editing && userActions) {
    const canSubmitEdit = Boolean(
      selectComposerDocumentText(draft).trim() || attachmentParts.length > 0
    )
    return (
      <Message align="end" className="group/msg">
        <MessageContent className="items-end">
          <form
            className="flex w-full max-w-[78%] flex-col items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (!canSubmitEdit) return
              setEditing(false)
              userActions.onEdit(draft)
            }}
          >
            <label className="sr-only" htmlFor="latest-message-editor">
              编辑最新消息
            </label>
            {attachmentParts.length > 0 ? (
              <AttachmentGroup aria-label="原消息附件" className="max-w-full justify-end">
                {attachmentParts.map((part) => (
                  <MessageAttachment
                    key={part.id}
                    part={part}
                    readOnly
                    alignMixedAttachmentHeights={alignMixedAttachmentHeights}
                  />
                ))}
              </AttachmentGroup>
            ) : null}
            <RichPromptInput
              id="latest-message-editor"
              value={draft}
              rows={Math.max(2, Math.min(8, selectComposerDocumentText(draft).split("\n").length))}
              placeholder="编辑最新消息"
              disabled={false}
              onChange={setDraft}
              onSubmit={() => {
                if (!canSubmitEdit) return
                setEditing(false)
                userActions.onEdit(draft)
              }}
              className="text-ui-small min-h-20 w-full resize-y rounded-xl bg-user-message/70 px-4 py-3 leading-6 whitespace-pre-wrap text-foreground outline-none"
            />
            <div className="flex items-center gap-1">
              <MessageActionButton label="取消编辑" onClick={() => setEditing(false)}>
                <X />
              </MessageActionButton>
              <Button
                type="submit"
                size="sm"
                disabled={!canSubmitEdit}
                className="bg-foreground text-background hover:bg-foreground/85"
              >
                <Check data-icon="inline-start" />
                重新生成
              </Button>
            </div>
          </form>
        </MessageContent>
      </Message>
    )
  }

  return (
    <Message align="end" className="group/msg">
      <MessageContent className="items-end">
        {attachmentParts.length > 0 ? (
          <AttachmentGroup aria-label="消息附件" className="max-w-[78%] justify-end">
            {attachmentParts.map((part) => (
              <MessageAttachment
                key={part.id}
                part={part}
                alignMixedAttachmentHeights={alignMixedAttachmentHeights}
              />
            ))}
          </AttachmentGroup>
        ) : null}
        {content.trim() || items.length > 0 ? (
          <UserMessageBubble content={content} items={items} />
        ) : null}
        <MessageToolbar align="end" timestamp={timestamp}>
          {content.trim() ? (
            <MessageActionButton
              label="复制消息"
              onClick={() => void window.desktop.clipboard.writeText(content)}
            >
              <Copy />
            </MessageActionButton>
          ) : null}
          {canEdit ? (
            <MessageActionButton
              label="重新编辑"
              onClick={() => {
                setDraft(document)
                setEditing(true)
              }}
            >
              <PencilLine />
            </MessageActionButton>
          ) : null}
        </MessageToolbar>
      </MessageContent>
    </Message>
  )
}

export type UserDisplayItem =
  | { kind: "text"; text: string }
  | { kind: "skill"; name: string; displayName: string }
  | { kind: "context"; name: string; displayName: string }
  | { kind: "plugin"; name: string; displayName: string }

export function renderUserItems(items: readonly SessionUserInputItem[]): UserDisplayItem[] {
  return items.flatMap((item): UserDisplayItem[] => {
    if (item.type === "text") return item.text ? [{ kind: "text", text: item.text }] : []
    if (item.type === "context")
      return [{ kind: "context", name: item.id, displayName: item.displayName }]
    if (item.type === "capability")
      return [{ kind: "plugin", name: item.pluginId, displayName: item.displayName }]
    const name = item.name.trim()
    if (!name) return []
    return [{ kind: "skill", name, displayName: item.displayName?.trim() || name }]
  })
}

function readUserItems(parts: DesktopSessionPart[]): UserDisplayItem[] {
  for (const part of parts) {
    if (part.type !== "text") continue
    const items = part.metadata.items
    if (!Array.isArray(items)) continue
    return renderUserItems(items as SessionUserInputItem[])
  }
  return []
}

function UserMessageBubble({
  content,
  items,
}: {
  content: string
  items: UserDisplayItem[]
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const longEnough =
    content.length > collapsibleUserMessageChars ||
    content.split("\n").length > collapsibleUserMessageLines
  const collapsed = longEnough && !expanded

  return (
    <div className="text-ui-small max-w-[78%] overflow-hidden rounded-xl bg-input/50 leading-6 text-sidebar-foreground">
      <div className="relative">
        <div
          className={cn("px-4 py-3 whitespace-pre-wrap", collapsed && "max-h-72 overflow-hidden")}
        >
          {items.length > 0
            ? items.map((item, index) =>
                item.kind === "text" ? (
                  <span key={index}>{item.text}</span>
                ) : (
                  <span
                    key={index}
                    className="inline-flex items-center gap-1 align-baseline font-medium !text-primary select-none"
                  >
                    {item.kind !== "plugin" ? <Box className="size-3.5 shrink-0" /> : null}
                    <span>
                      {item.kind === "plugin" ? "@" : ""}
                      {item.displayName}
                    </span>
                  </span>
                )
              )
            : content}
        </div>
        {collapsed ? (
          <div className="pointer-events-none absolute right-0 bottom-0 left-0 h-16 bg-linear-to-b from-input/0 to-input/95" />
        ) : null}
      </div>
      {longEnough ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex h-9 w-full items-center justify-start gap-1 border-t border-border/40 px-4 text-xs font-medium text-muted-foreground transition-colors hover:bg-background/35 hover:text-foreground"
        >
          <span>{expanded ? "收起" : "显示更多"}</span>
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
      ) : null}
    </div>
  )
}

export function AssistantMessageActions({
  message,
  content,
  disabled,
  onCopy,
  onFork,
}: {
  message?: DesktopSessionMessage
  content: string
  disabled: boolean
  onCopy: (content: string) => void
  onFork?: (messageId: string) => void
}): React.JSX.Element | null {
  if (!message) return null
  return (
    <MessageToolbar align="start" timestamp={message.updatedAt}>
      {content.trim() ? (
        <MessageActionButton label="复制回复" onClick={() => onCopy(content)} disabled={disabled}>
          <Copy />
        </MessageActionButton>
      ) : null}
      {onFork ? (
        <MessageActionButton
          label="从这条回复分叉"
          onClick={() => onFork(message.id)}
          disabled={disabled}
        >
          <GitBranchPlus />
        </MessageActionButton>
      ) : null}
    </MessageToolbar>
  )
}

function MessageToolbar({
  align,
  timestamp,
  children,
}: {
  align: "start" | "end"
  timestamp: number
  children?: React.ReactNode
}): React.JSX.Element {
  const label = formatMessageTime(timestamp)
  const absolute = new Date(timestamp).toLocaleString()
  const time = (
    <time dateTime={new Date(timestamp).toISOString()} title={absolute} className="ml-0.5 shrink-0">
      {label}
    </time>
  )

  return (
    <div
      className={cn(
        "mt-1.5 flex h-7 items-center gap-0.5 text-xs text-ui-muted",
        "pointer-events-none opacity-0 transition-opacity",
        "group-hover/msg:pointer-events-auto group-hover/msg:opacity-100",
        "group-focus-within/msg:pointer-events-auto group-focus-within/msg:opacity-100",
        align === "end" ? "justify-end" : "justify-start"
      )}
    >
      {children}
      {time}
    </div>
  )
}

function MessageActionButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="text-muted-foreground/50 hover:text-muted-foreground"
    >
      {children}
    </Button>
  )
}

export function PermissionCard({
  permission,
  onReply,
  replyPending = false,
  replyError = null,
  className,
}: {
  permission: DesktopPermissionRequest
  onReply: (status: "approved" | "denied", decision?: "once" | "session") => void
  replyPending?: boolean
  replyError?: string | null
  className?: string
}): React.JSX.Element {
  return (
    <section className={cn("mt-6 rounded-xl border bg-background px-4 py-3 shadow-sm", className)}>
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-ui-muted">
          <ShieldCheck className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-ui-small font-semibold text-foreground">需要你的批准</h3>
          <p className="mt-1 text-xs text-ui-muted">
            {"OpenHarness 请求运行 "}
            {permission.toolName}
          </p>
          {replyError ? (
            <p role="alert" className="mt-1 text-xs leading-snug text-destructive">
              {replyError}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          className="text-xs text-muted-foreground"
          disabled={replyPending}
          onClick={() => onReply("denied")}
        >
          拒绝
        </Button>
        <Button
          type="button"
          variant="outline"
          className="text-xs"
          disabled={replyPending}
          onClick={() => onReply("approved", "once")}
        >
          {replyPending ? "正在提交" : "允许"}
        </Button>
      </div>
    </section>
  )
}
