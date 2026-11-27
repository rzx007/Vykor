import { AppWindow } from "lucide-react"
import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { ApprovalRequestCard } from "@renderer/components/desktop/conversation-page/message/blocks/permission-card"
import type { DesktopComputerPrompt } from "@shared/computer-types"
import { ComputerInteractionDialog } from "./computer-interaction-dialog"

interface PromptState {
  prompt: DesktopComputerPrompt
  answering: boolean
  error?: string
}

const ComputerInteractionContext = createContext<{
  state: PromptState | null
  answer: (choice: string | null) => void
} | null>(null)

export function ComputerInteractionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<PromptState | null>(null)
  useEffect(() => window.desktop?.computer?.onInteraction?.((event) => {
    if (event.type === "prompt") setState({ prompt: event.prompt, answering: false })
    else setState((current) => current?.prompt.id === event.id ? null : current)
  }), [])

  function answer(choice: string | null): void {
    if (!state || state.answering) return
    const { prompt } = state
    setState((current) => current?.prompt.id === prompt.id ? { prompt, answering: true } : current)
    void window.desktop.computer.reply({ id: prompt.id, choice }).then(
      () => setState((current) => current?.prompt.id === prompt.id ? null : current),
      () => setState((current) => current?.prompt.id === prompt.id
        ? { prompt, answering: false, error: "无法提交选择，请重试。" }
        : current),
    )
  }

  return (
    <ComputerInteractionContext value={{ state, answer }}>
      {children}
      {state?.prompt.kind === "choose" ? (
        <ComputerInteractionDialog key={state.prompt.id} prompt={state.prompt} answering={state.answering} error={state.error} answer={answer} />
      ) : null}
    </ComputerInteractionContext>
  )
}

export function useComputerAppPermissionId(sessionId?: string | null): string | undefined {
  const prompt = useContext(ComputerInteractionContext)?.state?.prompt
  return prompt?.kind === "authorize" && prompt.sessionId === sessionId ? prompt.id : undefined
}

export function useComputerAppPermission(sessionId?: string | null): boolean {
  return !!useComputerAppPermissionId(sessionId)
}

export function ComputerAppPermissionCard({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const interaction = useContext(ComputerInteractionContext)
  const state = interaction?.state
  if (!interaction || !state || state.prompt.kind !== "authorize" || state.prompt.sessionId !== sessionId) return null
  return (
    <ApprovalRequestCard
      key={state.prompt.id}
      title={`允许 Vykor 使用「${state.prompt.appName}」？`}
      icon={AppWindow}
      approveLabel="仅本任务"
      replyPending={state.answering}
      replyError={state.error}
      onApprove={() => interaction.answer("once")}
      onDeny={() => interaction.answer(null)}
      remember={{ label: `始终允许使用「${state.prompt.appName}」`, onApprove: () => interaction.answer("always") }}
    />
  )
}
