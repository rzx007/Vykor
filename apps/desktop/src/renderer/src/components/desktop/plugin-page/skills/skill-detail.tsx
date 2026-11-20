import { useState } from "react"
import { cjk } from "@streamdown/cjk"
import { MessageCircle, MoreHorizontal, X } from "lucide-react"
import { Streamdown } from "streamdown"
import type { DesktopSkillInfo } from "@shared/skill-types"
import { Button } from "@renderer/components/ui/button"
import {
  Dialog,
  DialogClose,
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
import { toLocalFileUrl } from "@renderer/components/desktop/tools/browser/browser-navigation"
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
  overriddenByProject,
  onClose,
  onRemove,
  onTry,
  notify,
}: {
  skill: DesktopSkillInfo
  overriddenByProject?: boolean
  onClose: () => void
  onRemove?: () => Promise<string | null>
  onTry?: (skill: DesktopSkillInfo) => Promise<void>
  notify: (message: string) => void
}): React.JSX.Element {
  const [error, setError] = useState("")
  const [confirm, setConfirm] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [trying, setTrying] = useState(false)
  const removeAction = skill.marketplace ? "卸载" : "删除"
  const path = skill.path.replace(/\\/g, "/")
  const isFile = /^(?:[a-z]:\/|\/)/i.test(path)
  const fileStart = path.lastIndexOf("/") + 1

  async function fileAction(action: () => Promise<void>, message: string): Promise<void> {
    try {
      await action()
      setError("")
    } catch {
      setError(message)
    }
  }

  async function trySkill(): Promise<void> {
    if (!onTry || trying) return
    setTrying(true)
    setError("")
    try {
      await onTry(skill)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法打开技能试用，请重试。")
    } finally {
      setTrying(false)
    }
  }
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
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 rounded-3xl p-5 sm:max-w-[660px] sm:p-6"
      >
        <div className="flex shrink-0 items-start justify-between gap-3">
          <SkillIcon
            name={skill.name}
            className="size-11 rounded-full border border-border/60 bg-background"
          />
          <div className="flex items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    shape="circle"
                    className="bg-muted"
                    aria-label={`${skill.name} 更多操作`}
                  />
                }
              >
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuGroup>
                  {isFile ? (
                    <>
                      <DropdownMenuItem
                        onClick={() =>
                          void fileAction(
                            () =>
                              window.desktop.window.openExternal(
                                path.startsWith("//")
                                  ? `file:${path.split("/").map(encodeURIComponent).join("/")}`
                                  : toLocalFileUrl("", path)
                              ),
                            "无法打开技能文件。"
                          )
                        }
                      >
                        打开
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() =>
                          void fileAction(
                            () =>
                              window.desktop.workspace.revealPath({
                                rootPath: path.slice(0, fileStart),
                                path: path.slice(fileStart),
                              }),
                            "无法在文件资源管理器中显示技能文件。"
                          )
                        }
                      >
                        在文件资源管理器中显示
                      </DropdownMenuItem>
                    </>
                  ) : null}
                  <DropdownMenuItem onClick={() => void copy()}>复制 Markdown</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => exportSkillMarkdown(skill.content, skill.name)}>
                    导出 Markdown
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <DialogClose
              render={
                <Button variant="ghost" size="icon" shape="circle" aria-label="关闭技能详情" />
              }
            >
              <X />
            </DialogClose>
          </div>
        </div>
        <DialogHeader className="min-h-0 gap-1.5">
          <DialogTitle className="flex shrink-0 flex-wrap items-baseline gap-2 text-xl font-semibold tracking-tight break-words">
            {skill.name}
            <span className="font-normal text-muted-foreground">Skill</span>
          </DialogTitle>
          <DialogDescription className="max-h-[min(38dvh,22rem)] min-h-0 overflow-y-auto overscroll-contain text-sm leading-6 break-words">
            {skill.description}
          </DialogDescription>
          <p className="shrink-0 text-xs text-muted-foreground">
            {skill.projectName ? `${skill.projectName} · ` : ""}
            {sourceLabels[skill.source]}
            {skill.marketplace ? ` · 官方技能市场 ${skill.marketplace.version}` : ""}
          </p>
          {overriddenByProject ? (
            <p className="text-xs text-muted-foreground">当前项目优先使用同名的项目技能。</p>
          ) : null}
        </DialogHeader>
        <article
          tabIndex={0}
          aria-label={`${skill.name} 技能说明`}
          className="desktop-markdown-preview max-h-[min(37dvh,23rem)] min-h-[min(7rem,18dvh)] flex-1 overflow-auto overscroll-contain rounded-xl border border-border/60 bg-background/50 px-4 py-4 text-sm leading-6 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Streamdown
            mode="static"
            controls={{ code: { copy: true, download: false } }}
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
        {(!skill.readOnly && onRemove) || (onTry && skill.path) ? (
          <DialogFooter className="shrink-0 flex-row items-center justify-between sm:justify-between">
            {!skill.readOnly && onRemove ? (
              <Button
                variant="destructive"
                shape="pill"
                onClick={() => {
                  setError("")
                  setConfirm(true)
                }}
              >
                {removeAction}
              </Button>
            ) : null}
            {onTry && skill.path ? (
              <Button
                shape="pill"
                className="ml-auto"
                disabled={trying || overriddenByProject}
                onClick={() => void trySkill()}
              >
                <MessageCircle data-icon="inline-start" />
                {trying ? "正在打开…" : "立即试用"}
              </Button>
            ) : null}
          </DialogFooter>
        ) : null}
        <SkillConfirm
          open={confirm}
          title={`${removeAction} ${skill.name}？`}
          description={
            skill.marketplace
              ? `将移除${skill.projectName ?? "个人"}范围中的这份技能及其打包资料。`
              : "将删除这个技能的入口 Markdown 文件。技能目录中的其他资料会保留。"
          }
          action={removing ? `正在${removeAction}…` : `确认${removeAction}`}
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
