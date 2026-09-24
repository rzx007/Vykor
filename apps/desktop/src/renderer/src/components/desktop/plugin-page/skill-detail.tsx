import { useState } from "react"
import { cjk } from "@streamdown/cjk"
import { Copy, Download, MoreHorizontal, Trash2 } from "lucide-react"
import { Streamdown } from "streamdown"
import type { DesktopSkillInfo } from "@shared/skill-types"
import { Button } from "@renderer/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu"
import { SkillConfirm, SkillIcon } from "./skill-controls"
import { exportSkillMarkdown } from "./skill-export"

const sourceLabels: Record<DesktopSkillInfo["source"], string> = {
  bundled: "内置 · 只读",
  agent: "Agent 目录 · 只读",
  standard: "通用 · 只读",
  project: "项目技能",
  personal: "个人 · VK 全局技能",
}

export function SkillDetail({
  skill,
  onClose,
  onRemove,
  notify,
}: {
  skill: DesktopSkillInfo
  onClose: () => void
  onRemove?: () => Promise<string | null>
  notify: (message: string) => void
}): React.JSX.Element {
  const [error, setError] = useState("")
  const [confirm, setConfirm] = useState(false)
  const [removing, setRemoving] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      if (window.desktop?.clipboard) await window.desktop.clipboard.writeText(skill.content)
      else await navigator.clipboard.writeText(skill.content)
      notify("已复制完整 SKILL.md")
      setError("")
    } catch {
      setError("复制失败，请使用导出 Markdown 保存文件。")
    }
  }
  const remove = async (): Promise<void> => {
    if (!onRemove || removing) return
    setRemoving(true)
    const failure = await onRemove()
    setRemoving(false)
    if (failure) setError(failure)
    else setConfirm(false)
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-5 p-6 sm:max-w-2xl">
        <div className="flex shrink-0 items-center justify-between gap-3 pr-6">
          <SkillIcon name={skill.name} />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label={`${skill.name} 更多操作`} />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => void copy()}>
                  <Copy />
                  复制 Markdown
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportSkillMarkdown(skill.content, skill.name)}>
                  <Download />
                  导出 Markdown
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex flex-wrap items-baseline gap-2 break-all">
            {skill.name}
            <span className="text-sm font-normal text-muted-foreground">Skill</span>
          </DialogTitle>
          <DialogDescription>{skill.description}</DialogDescription>
          <p className="text-xs text-muted-foreground">
            {skill.projectName ? `${skill.projectName} · ` : ""}
            {sourceLabels[skill.source]}
          </p>
        </DialogHeader>
        <article
          tabIndex={0}
          aria-label={`${skill.name} 技能说明`}
          className="desktop-markdown-preview min-h-0 flex-1 overflow-auto rounded-xl bg-muted/40 px-5 py-4 text-sm leading-7 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Streamdown
            mode="static"
            controls={false}
            plugins={{ cjk }}
            className="desktop-streamdown"
          >
            {skillBody(skill.content)}
          </Streamdown>
        </article>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {!skill.readOnly && onRemove ? (
          <DialogFooter className="shrink-0 sm:justify-start">
            <Button
              variant="destructive"
              onClick={() => {
                setError("")
                setConfirm(true)
              }}
            >
              <Trash2 data-icon="inline-start" />
              删除
            </Button>
          </DialogFooter>
        ) : null}
        <SkillConfirm
          open={confirm}
          title={`删除 ${skill.name}？`}
          description="将删除这个技能的入口 Markdown 文件。技能目录中的其他资料会保留。"
          action={removing ? "正在删除…" : "确认删除"}
          error={error}
          onCancel={() => !removing && setConfirm(false)}
          onConfirm={() => void remove()}
        />
      </DialogContent>
    </Dialog>
  )
}

function skillBody(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n")
  if (!normalized.startsWith("---\n")) return normalized
  const end = normalized.indexOf("\n---", 4)
  return end < 0 ? normalized : normalized.slice(end + 4).trimStart()
}
