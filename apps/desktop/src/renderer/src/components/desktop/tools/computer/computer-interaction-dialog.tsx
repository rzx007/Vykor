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

export function ComputerInteractionDialog({ prompt, answering, error, answer }: {
  prompt: Extract<DesktopComputerPrompt, { kind: "choose" }>
  answering: boolean
  error?: string
  answer: (choice: string | null) => void
}): React.JSX.Element {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) answer(null) }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {prompt.confirmChange ? "确认继续使用这个窗口？" : "选择要使用的目标"}
          </DialogTitle>
          <DialogDescription>
            {prompt.confirmChange ? "窗口标题已变更，确认后再读取内容。" : "当前有多个匹配项，选中后继续本次任务。"}
          </DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[50vh] gap-1 overflow-y-auto" aria-label="匹配目标">
          {prompt.candidates.map((candidate) => (
            <Button key={candidate.id} type="button" variant="outline"
              className="h-auto min-w-0 justify-start whitespace-normal px-3 py-2 text-left"
              disabled={answering} onClick={() => answer(candidate.id)}>
              <span className="min-w-0 break-words">
                {candidate.label}
                {candidate.detail ? (
                  <span className="block text-xs font-normal text-muted-foreground">{candidate.detail}</span>
                ) : null}
              </span>
            </Button>
          ))}
        </div>
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={answering} onClick={() => answer(null)}>取消</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
