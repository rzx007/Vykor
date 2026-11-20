import { useEffect, useState } from "react"
import { CircleAlert, CircleCheck, Download, RefreshCw } from "lucide-react"
import type {
  DesktopSkillMarketplaceCatalog,
  DesktopSkillMarketplaceEntry,
  DesktopSkillProject,
  DesktopSkillSnapshot,
} from "@shared/skill-types"
import { Alert, AlertDescription } from "@renderer/components/ui/alert"
import { Button } from "@renderer/components/ui/button"
import { ButtonGroup } from "@renderer/components/ui/button-group"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@renderer/components/ui/empty"
import { Skeleton } from "@renderer/components/ui/skeleton"
import { SkillIcon } from "./skill-controls"

export function SkillMarketplace({
  project,
  snapshot,
  query,
  refreshRequest,
  onInstalled,
}: {
  project: DesktopSkillProject | undefined
  snapshot: DesktopSkillSnapshot | null
  query: string
  refreshRequest: number
  onInstalled: (snapshot: DesktopSkillSnapshot, message: string) => void
}): React.JSX.Element {
  const [catalog, setCatalog] = useState<{
    entries: DesktopSkillMarketplaceCatalog
    error?: string
    refreshRequest: number
    attempt: number
  }>()
  const [scope, setScope] = useState<"personal" | "project">("personal")
  const [pending, setPending] = useState<string | null>(null)
  const [actionError, setActionError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const [restarting, setRestarting] = useState(false)
  const [restarted, setRestarted] = useState(false)
  const targetProject = scope === "project" ? project : undefined
  const api = window.desktop.skills
  const current =
    catalog?.refreshRequest === refreshRequest && catalog.attempt === attempt ? catalog : undefined
  const unsupported = current?.entries === null
  const entries = current?.entries ?? []

  useEffect(() => {
    let active = true
    void api.marketplace().then(
      (result) => {
        if (active) setCatalog({ entries: result, refreshRequest, attempt })
      },
      (cause: unknown) => {
        if (active) setCatalog({ entries: [], error: failure(cause), refreshRequest, attempt })
      }
    )
    return () => {
      active = false
    }
  }, [api, attempt, refreshRequest])

  function retry(): void {
    setActionError("")
    setAttempt((value) => value + 1)
  }

  async function restart(): Promise<void> {
    setRestarting(true)
    setActionError("")
    try {
      await window.desktop.maintenance.restart()
      setRestarted(true)
      retry()
    } catch (cause) {
      setActionError(failure(cause))
    } finally {
      setRestarting(false)
    }
  }

  async function install(entry: DesktopSkillMarketplaceEntry): Promise<void> {
    if (pending || (scope === "project" && !targetProject)) return
    setPending(entry.id)
    setActionError("")
    try {
      const result = await api.installMarketplace({
        id: entry.id,
        version: entry.version,
        sha256: entry.artifact.sha256,
        ...(targetProject
          ? { scope: "project", projectPath: targetProject.path }
          : { scope: "personal" }),
      })
      onInstalled(result, `${entry.displayName} 已安装到${targetProject?.name ?? "个人"}。`)
    } catch (cause) {
      setActionError(failure(cause))
    } finally {
      setPending(null)
    }
  }

  const needle = query.trim().toLocaleLowerCase()
  const visible = entries.filter((entry) =>
    `${entry.name} ${entry.displayName} ${entry.description}`.toLocaleLowerCase().includes(needle)
  )
  const local = snapshot?.skills.filter((skill) =>
    targetProject
      ? skill.source === "project" && skill.projectPath === targetProject.path
      : skill.source === "personal"
  )
  const canRestart = unsupported && !restarted
  const unavailable = unsupported || Boolean(current?.error)

  return (
    <section
      aria-label="技能市场"
      aria-busy={!current || restarting}
      className="flex min-w-0 flex-col gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="text-[15px] font-semibold">官方技能市场</h2>
        {entries.length ? (
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-xs text-muted-foreground">安装到</span>
            {project ? (
              <ButtonGroup variant="toolbar" aria-label="安装范围">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  shape="pill"
                  aria-pressed={!targetProject}
                  className="aria-pressed:bg-accent"
                  disabled={pending !== null}
                  onClick={() => {
                    setScope("personal")
                    setActionError("")
                  }}
                >
                  个人
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  shape="pill"
                  aria-label={`当前项目 · ${project.name}`}
                  title={project.path}
                  aria-pressed={Boolean(targetProject)}
                  className="aria-pressed:bg-accent"
                  disabled={pending !== null}
                  onClick={() => {
                    setScope("project")
                    setActionError("")
                  }}
                >
                  当前项目
                </Button>
              </ButtonGroup>
            ) : (
              <span className="text-sm">个人</span>
            )}
          </div>
        ) : null}
      </div>
      {targetProject && entries.length ? (
        <p className="truncate text-xs text-muted-foreground" title={targetProject.path}>
          {targetProject.name} · {targetProject.path}
        </p>
      ) : null}
      {actionError ? (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}
      {!current ? (
        <div role="status" aria-label="正在加载技能市场" className="divide-y divide-border/50">
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex h-16 items-center gap-3">
              <Skeleton className="size-10 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-3 w-32 max-w-full" />
                <Skeleton className="h-3 w-64 max-w-full" />
              </div>
              <Skeleton className="h-8 w-16 rounded-full" />
            </div>
          ))}
        </div>
      ) : unavailable ? (
        <Empty className="py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CircleAlert />
            </EmptyMedia>
            <EmptyTitle>
              {unsupported ? "当前后台暂不支持技能市场" : "暂时无法读取技能市场"}
            </EmptyTitle>
            <EmptyDescription>
              {unsupported
                ? canRestart
                  ? "安全重启后台后，桌面会重新读取官方目录。"
                  : "请更新 Vykor 后台后再试。"
                : current.error}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              type="button"
              size="default"
              variant="outline"
              shape="pill"
              disabled={restarting}
              onClick={() => {
                if (canRestart) void restart()
                else retry()
              }}
            >
              <RefreshCw data-icon="inline-start" aria-hidden="true" />
              {restarting ? "正在重启后台…" : canRestart ? "安全重启并重试" : "重试"}
            </Button>
          </EmptyContent>
        </Empty>
      ) : visible.length === 0 ? (
        <Empty className="py-7">
          <EmptyHeader>
            <EmptyTitle>{needle ? "没有匹配的技能" : "市场暂无技能"}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="divide-y divide-border/50">
          {visible.map((entry) => {
            const existing = local?.find((skill) => skill.name.toLocaleLowerCase() === entry.name)
            const record = existing?.marketplace
            const sameSource = record?.id === entry.id
            const sameVersion = sameSource && record.version === entry.version
            const installed = sameVersion && record.sha256 === entry.artifact.sha256
            const conflict = Boolean(existing && (!sameSource || (sameVersion && !installed)))
            const action = pending === entry.id ? "正在安装…" : existing ? "更新" : "安装"
            return (
              <li
                key={entry.id}
                data-extension-row
                className="flex min-h-16 min-w-0 items-center gap-3 py-3"
              >
                <SkillIcon name={entry.name} />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="truncate text-sm font-medium" title={entry.name}>
                    {entry.displayName}
                  </p>
                  <p
                    className="truncate text-xs leading-5 text-muted-foreground"
                    title={entry.description}
                  >
                    {entry.description}
                  </p>
                  <p
                    className="truncate text-xs text-muted-foreground"
                    title={conflict ? existing?.path : entry.requirements}
                  >
                    {entry.version} · {entry.license}
                    {entry.requirements ? ` · ${entry.requirements}` : ""}
                  </p>
                </div>
                {installed ? (
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <CircleCheck className="size-4" aria-hidden="true" />
                    已安装
                  </span>
                ) : conflict ? (
                  <span className="shrink-0 text-xs text-muted-foreground" title={existing?.path}>
                    同名冲突
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="default"
                    variant="outline"
                    shape="pill"
                    aria-label={`${action} ${entry.displayName}`}
                    disabled={pending !== null || !snapshot}
                    onClick={() => void install(entry)}
                  >
                    {existing ? (
                      <RefreshCw data-icon="inline-start" />
                    ) : (
                      <Download data-icon="inline-start" />
                    )}
                    {action}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function failure(cause: unknown): string {
  const message =
    cause instanceof Error
      ? cause.message
          .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/, "")
          .replace(/^(?:Error|VykorApiError):\s*/, "")
          .trim()
      : ""
  return message || "技能市场操作失败，请重试。"
}
