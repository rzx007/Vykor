import { useEffect, useState } from "react"
import { Button } from "@renderer/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import type { DesktopComputerPrompt } from "@shared/computer-types"

export function ComputerInteractionDialog(): React.JSX.Element | null {
  const [prompt, setPrompt] = useState<DesktopComputerPrompt | null>(null)
  const [answering, setAnswering] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => window.desktop?.computer?.onInteraction?.((event) => {
    if (event.type === "prompt") {
      setPrompt(event.prompt)
      setAnswering(false)
      setError(false)
      return
    }
    setPrompt((current) => current?.id === event.id ? null : current)
  }), [])

  if (!prompt) return null
  const requested = prompt
  async function answer(choice: string | null): Promise<void> {
    if (answering) return
    setAnswering(true)
    setError(false)
    try {
      await window.desktop.computer.reply({ id: requested.id, choice })
      setPrompt((current) => current?.id === requested.id ? null : current)
    } catch {
      setError(true)
      setAnswering(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) void answer(null) }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {prompt.kind === "authorize" ? "允许电脑操作使用此应用？" : "选择要使用的目标"}
          </DialogTitle>
          <DialogDescription>
            {prompt.kind === "authorize" ? prompt.appName : "当前有多个匹配项，选中后继续本次任务。"}
          </DialogDescription>
        </DialogHeader>
        {prompt.kind === "choose" ? (
          <div className="grid max-h-[50vh] gap-1 overflow-y-auto" aria-label="匹配目标">
            {prompt.candidates.map((candidate) => (
              <Button key={candidate.id} type="button" variant="outline"
                className="h-auto min-w-0 justify-start whitespace-normal px-3 py-2 text-left"
                disabled={answering} onClick={() => void answer(candidate.id)}>
                <span className="min-w-0 break-words">
                  {candidate.label}
                  {candidate.detail ? (
                    <span className="block text-xs font-normal text-muted-foreground">{candidate.detail}</span>
                  ) : null}
                </span>
              </Button>
            ))}
          </div>
        ) : null}
        {error ? <p role="alert" className="text-destructive">无法提交选择，请重试。</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={answering} onClick={() => void answer(null)}>取消</Button>
          {prompt.kind === "authorize" ? (<>
            <Button type="button" variant="outline" disabled={answering} onClick={() => void answer("always")}>始终允许</Button>
            <Button type="button" disabled={answering} onClick={() => void answer("once")}>仅本任务</Button>
          </>) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
