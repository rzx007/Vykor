import { useConversationSearchMatch } from "../../transcript/conversation-scroll-context"
import { PencilLine } from "lucide-react"
import { useEffect, useState } from "react"
import { AttachmentGroup } from "@renderer/components/ui/attachment"
import { Button } from "@renderer/components/ui/button"
import { Message, MessageContent } from "@renderer/components/ui/message"
import {
  composerDocument,
  selectComposerDocumentText,
  type ComposerDocument,
} from "@renderer/stores/desktop-session/composer-document"
import type {
  DesktopAttachmentSessionPart,
  DesktopSessionMessage,
  DesktopSessionPart,
  SessionUserInputItem,
} from "@shared/session-types"
import { RichPromptInput } from "../../composer/rich-prompt-input"
import { useRetainTranscriptRow } from "../../transcript/virtual-transcript-row"
import { MessageAttachment } from "../attachments/message-attachment"
import { CopyActionButton, MessageActionButton, MessageToolbar } from "./message-actions"
import { messageTextContent } from "../models/message-content"
import { UserMessageBubble } from "./user-message-bubble"
import { renderUserItems, type UserDisplayItem } from "./user-display-items"

export interface UserMessageActions {
  canEdit: boolean
  onEdit: (document: ComposerDocument) => void
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
}

export function UserMessage({
  message,
  parts,
  inputItems,
  userActions,
}: {
  message: DesktopSessionMessage
  parts: DesktopSessionPart[]
  inputItems?: SessionUserInputItem[]
  userActions?: UserMessageActions
}): React.JSX.Element {
  const searchReveal = useConversationSearchMatch(message.id)
  const content = messageTextContent(parts)
  const items = readUserItems(parts)
  const attachmentParts = parts
    .filter((part): part is DesktopAttachmentSessionPart => part.type === "attachment")
    .sort((left, right) => left.seq - right.seq)
  return (
    <UserMessageBlock
      content={content}
      searchReveal={searchReveal}
      searchSource={{
        messageId: message.id,
        partIds: parts.filter((part) => part.type === "text").map((part) => part.id),
      }}
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

function UserMessageBlock({
  content,
  searchReveal,
  searchSource,
  items,
  document,
  attachmentParts,
  timestamp,
  userActions,
}: {
  content: string
  searchReveal: ReturnType<typeof useConversationSearchMatch>
  searchSource: { messageId: string; partIds: string[] }
  items: UserDisplayItem[]
  document: ComposerDocument
  attachmentParts: DesktopAttachmentSessionPart[]
  timestamp: number
  userActions?: UserMessageActions
}): React.JSX.Element {
  const [localEditing, setLocalEditing] = useState(false)
  const editing = userActions?.editing ?? localEditing
  const setEditing = userActions?.onEditingChange ?? setLocalEditing
  useRetainTranscriptRow(editing)
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
            className="flex min-h-36 w-full min-w-0 flex-col gap-2 rounded-2xl bg-muted pb-3"
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
              <AttachmentGroup
                aria-label="原消息附件"
                className="max-w-full"
                style={{ justifyContent: "safe flex-end" }}
              >
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
              className="text-chat w-full resize-y bg-transparent px-4 py-3 whitespace-pre-wrap text-foreground outline-none"
            />
            <div className="mt-auto flex shrink-0 items-center justify-end gap-2 px-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                shape="pill"
                aria-label="取消编辑"
                onClick={() => {
                  setDraft(document)
                  setEditing(false)
                }}
              >
                取消
              </Button>
              <Button
                type="submit"
                size="sm"
                shape="pill"
                disabled={!canSubmitEdit}
                className="bg-foreground text-background hover:bg-foreground/85"
              >
                发送
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
          <AttachmentGroup
            aria-label="消息附件"
            className="max-w-[78%]"
            style={{ justifyContent: "safe flex-end" }}
          >
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
          <UserMessageBubble
            content={content}
            items={items}
            searchReveal={searchReveal}
            searchSource={searchSource}
          />
        ) : null}
        <MessageToolbar align="end" timestamp={timestamp}>
          {content.trim() ? (
            <CopyActionButton
              label="复制消息"
              copiedLabel="已复制"
              onCopy={() => window.desktop.clipboard.writeText(content)}
            />
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

function readUserItems(parts: DesktopSessionPart[]): UserDisplayItem[] {
  for (const part of parts) {
    if (part.type !== "text") continue
    const items = part.metadata.items
    if (!Array.isArray(items)) continue
    return renderUserItems(items as SessionUserInputItem[])
  }
  return []
}
