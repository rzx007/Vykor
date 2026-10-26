import type {
  DesktopSessionMessage,
  DesktopSessionPart,
  SessionUserInputItem,
} from "@shared/session-types"
import type { ComposerDocument } from "@renderer/stores/desktop-session/composer-document"
import { AssistantMessage } from "./assistant-message"
import { UserMessage } from "./user-message"
import { ModelSwitchDivider, readModelSwitchPresentation } from "../notices/model-switch-divider"
import { ContextCompactionDivider } from "../notices/context-compaction-divider"
import { readContextCompactionPresentation } from "../notices/compaction-presentation"

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
    return (
      <UserMessage
        message={message}
        parts={parts}
        inputItems={inputItems}
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
