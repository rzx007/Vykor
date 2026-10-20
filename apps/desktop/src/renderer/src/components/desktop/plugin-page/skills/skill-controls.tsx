import {
  BookOpen,
  Bug,
  ClipboardCheck,
  FileText,
  GitPullRequest,
  ScanEye,
  Sparkles,
} from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"

export function SkillIcon({ name }: { name: string }): React.JSX.Element {
  const Icon =
    {
      "code-review": GitPullRequest,
      "debug-checklist": Bug,
      "test-plan": ClipboardCheck,
      "docs-writer": BookOpen,
      "release-notes": FileText,
      "accessibility-review": ScanEye,
    }[name] ?? Sparkles
  return (
    <span
      className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground"
      aria-hidden="true"
    >
      <Icon className="size-5" />
    </span>
  )
}

export function SkillConfirm({
  open,
  title,
  description,
  action,
  onCancel,
  onConfirm,
  error,
}: {
  open: boolean
  title: string
  description: string
  action: string
  onCancel: () => void
  onConfirm: () => void
  error?: string
}): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
