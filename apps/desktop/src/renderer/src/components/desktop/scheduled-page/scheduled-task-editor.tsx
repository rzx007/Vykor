import { BriefcaseBusiness, Folder, MessageCircle, X } from "lucide-react"
import { useId, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import { Input } from "@renderer/components/ui/input"
import { Label } from "@renderer/components/ui/label"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import { Textarea } from "@renderer/components/ui/textarea"
import { cn } from "@renderer/lib/utils"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import type {
  CreateDesktopScheduledTaskInput,
  DesktopScheduledTask,
  UpdateDesktopScheduledTaskInput,
} from "@shared/schedule-types"

type Frequency = "daily" | "weekdays" | "weekly" | "monthly" | "once" | "custom"
type Destination = "chat" | "standalone"
type Workspace = "project" | "outside_project"

export function ScheduledTaskEditor({
  open,
  task,
  busy,
  onOpenChange,
  onSave,
}: {
  open: boolean
  task: DesktopScheduledTask | null
  busy: boolean
  onOpenChange: (open: boolean) => void
  onSave: (
    input: CreateDesktopScheduledTaskInput | UpdateDesktopScheduledTaskInput
  ) => Promise<void>
}): React.JSX.Element {
  const projects = useDesktopSessionStore((state) => state.projects)
  const sessions = useDesktopSessionStore((state) => state.sessions)
  const archivedSessions = useDesktopSessionStore((state) => state.archivedSessions)
  const defaultModel = useDesktopSessionStore((state) => state.defaultModel)
  const nameId = useId()
  const promptId = useId()
  const initialSchedule = editorSchedule(task)
  const [name, setName] = useState(task?.name ?? "")
  const [prompt, setPrompt] = useState(task?.prompt ?? "")
  const [destination, setDestination] = useState<Destination>(task?.destination ?? "standalone")
  const [sessionId, setSessionId] = useState(task?.sessionId ?? sessions[0]?.id ?? "")
  const [workspace, setWorkspace] = useState<Workspace>(
    task?.projectPaths[0] ? "project" : "outside_project"
  )
  const [projectPath, setProjectPath] = useState(
    task?.projectPaths[0] ?? projects.find((project) => project.available)?.path ?? ""
  )
  const [frequency, setFrequency] = useState<Frequency>(initialSchedule.frequency)
  const [time, setTime] = useState(initialSchedule.time)
  const [weekday, setWeekday] = useState(initialSchedule.weekday)
  const [monthday, setMonthday] = useState(initialSchedule.monthday)
  const [onceAt, setOnceAt] = useState(initialSchedule.onceAt)
  const [error, setError] = useState<string | null>(null)

  const allSessions = [...sessions, ...archivedSessions].filter(
    (session, index, items) => items.findIndex((item) => item.id === session.id) === index
  )
  const selectedSession = allSessions.find((session) => session.id === sessionId)
  const selectedSessionLabel = selectedSession
    ? `${selectedSession.title || "新对话"}${
        selectedSession.workspaceMode === "outside_project" ? " · 不在项目中工作" : ""
      }${selectedSession.status === "archived" ? " · 已归档" : ""}`
    : "选择一个对话"
  const selectedProjectLabel =
    projects.find((project) => project.path === projectPath)?.name ?? "选择一个项目"
  const standaloneModel = task?.model ?? defaultModel
  const valid =
    name.trim().length > 0 &&
    prompt.trim().length > 0 &&
    (destination === "chat"
      ? Boolean(sessionId)
      : Boolean(standaloneModel) && (workspace === "outside_project" || Boolean(projectPath))) &&
    (frequency === "once" ? Boolean(onceAt) : Boolean(time))

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!valid || busy) return
    setError(null)
    try {
      const recurrence = buildRecurrence({
        frequency,
        time,
        weekday,
        monthday,
        onceAt,
        original: task?.recurrence,
        originalFormat: task?.recurrenceFormat,
      })
      const common = {
        name: name.trim(),
        prompt: prompt.trim(),
        recurrence: recurrence.value,
        recurrenceFormat: recurrence.format,
        timezone: task?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        destination,
        sessionId: destination === "chat" ? sessionId : undefined,
        projectPaths: destination === "standalone" && workspace === "project" ? [projectPath] : [],
        executionMode: "local" as const,
        model: destination === "standalone" ? (standaloneModel ?? undefined) : "",
        effort: destination === "chat" ? "" : task?.effort,
        permissionProfile:
          destination === "chat" ? { mode: "workspace_write" as const } : task?.permissionProfile,
      }
      await onSave(
        task
          ? common
          : {
              ...common,
              status: "active",
              permissionProfile: { mode: "workspace_write" },
              createdBy: "user",
            }
      )
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-3rem)] overflow-y-auto p-0 sm:max-w-2xl">
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader className="border-b border-border/70 px-5 py-4 pr-12">
            <DialogTitle>{task ? "编辑定时任务" : "创建定时任务"}</DialogTitle>
            <DialogDescription>
              设置 Agent 要做什么，以及每次运行使用哪个工作上下文。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6 px-5 py-5">
            <div className="space-y-4">
              <EditorField label="名称" htmlFor={nameId}>
                <Input
                  id={nameId}
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="例如：每日项目进展简报"
                  maxLength={100}
                />
              </EditorField>
              <EditorField label="每次运行的指令" htmlFor={promptId}>
                <Textarea
                  id={promptId}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="描述 Agent 每次运行需要完成的工作…"
                  className="min-h-28 resize-y leading-6"
                />
              </EditorField>
            </div>

            <section className="space-y-3">
              <SectionLabel>运行于</SectionLabel>
              <div className="grid gap-2 sm:grid-cols-2">
                <ChoiceButton
                  active={destination === "chat"}
                  icon={<MessageCircle />}
                  title="已有对话"
                  description="持续使用同一段上下文"
                  onClick={() => setDestination("chat")}
                />
                <ChoiceButton
                  active={destination === "standalone"}
                  icon={<BriefcaseBusiness />}
                  title="每次新对话"
                  description="每次运行保持独立"
                  onClick={() => setDestination("standalone")}
                />
              </div>

              {destination === "chat" ? (
                <EditorField label="对话">
                  <Select
                    value={sessionId || null}
                    onValueChange={(value) => {
                      if (value) setSessionId(value)
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue>{selectedSessionLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {allSessions.map((session) => (
                          <SelectItem
                            key={session.id}
                            value={session.id}
                            disabled={session.status === "archived"}
                          >
                            {session.title || "新对话"}
                            {session.workspaceMode === "outside_project" ? " · 不在项目中工作" : ""}
                            {session.status === "archived" ? " · 已归档" : ""}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </EditorField>
              ) : (
                <div className="space-y-3 rounded-xl bg-muted/45 p-3.5">
                  <div className="flex flex-wrap gap-2">
                    <WorkspaceButton
                      active={workspace === "project"}
                      icon={<Folder />}
                      onClick={() => setWorkspace("project")}
                    >
                      选择项目
                    </WorkspaceButton>
                    <WorkspaceButton
                      active={workspace === "outside_project"}
                      icon={<X />}
                      onClick={() => setWorkspace("outside_project")}
                    >
                      不在项目中工作
                    </WorkspaceButton>
                  </div>
                  {workspace === "project" ? (
                    <Select
                      value={projectPath || null}
                      onValueChange={(value) => {
                        if (value) setProjectPath(value)
                      }}
                    >
                      <SelectTrigger className="w-full bg-background">
                        <SelectValue>{selectedProjectLabel}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {projects.map((project) => (
                            <SelectItem
                              key={project.id}
                              value={project.path}
                              disabled={!project.available}
                            >
                              {project.name}
                              {project.available ? "" : " · 不可用"}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  ) : (
                    <p className="text-xs leading-5 text-muted-foreground">
                      每次运行都会创建一个独立工作目录，不读取任何已添加项目的文件。
                    </p>
                  )}
                  {!standaloneModel ? (
                    <p role="alert" className="text-xs text-destructive">
                      没有可用模型，请先在设置中连接模型提供商。
                    </p>
                  ) : null}
                </div>
              )}
            </section>

            <section className="space-y-3">
              <SectionLabel>频率</SectionLabel>
              <div className="grid gap-3 sm:grid-cols-2">
                <EditorField label="重复">
                  <Select
                    value={frequency}
                    onValueChange={(value) => {
                      if (value) setFrequency(value as Frequency)
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue>{frequencyLabels[frequency]}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="daily">每天</SelectItem>
                        <SelectItem value="weekdays">每个工作日</SelectItem>
                        <SelectItem value="weekly">每周</SelectItem>
                        <SelectItem value="monthly">每月</SelectItem>
                        <SelectItem value="once">仅一次</SelectItem>
                        {frequency === "custom" ? (
                          <SelectItem value="custom">自定义规则（保持不变）</SelectItem>
                        ) : null}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </EditorField>
                {frequency === "custom" ? (
                  <p className="self-end pb-2 text-xs leading-5 text-muted-foreground">
                    当前规则由 Agent 创建。选择其他重复方式后可改为常规频率。
                  </p>
                ) : frequency === "once" ? (
                  <EditorField label="运行时间">
                    <Input
                      type="datetime-local"
                      value={onceAt}
                      onChange={(event) => setOnceAt(event.target.value)}
                    />
                  </EditorField>
                ) : (
                  <EditorField label="时间">
                    <Input
                      type="time"
                      value={time}
                      onChange={(event) => setTime(event.target.value)}
                    />
                  </EditorField>
                )}
                {frequency === "weekly" ? (
                  <EditorField label="星期">
                    <Select
                      value={weekday}
                      onValueChange={(value) => {
                        if (value) setWeekday(value)
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue>
                          {weekdayOptions.find(([value]) => value === weekday)?.[1] ?? "选择星期"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {weekdayOptions.map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </EditorField>
                ) : null}
                {frequency === "monthly" ? (
                  <EditorField label="日期">
                    <Input
                      type="number"
                      min={1}
                      max={31}
                      value={monthday}
                      onChange={(event) => setMonthday(event.target.value)}
                    />
                  </EditorField>
                ) : null}
              </div>
            </section>

            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter className="border-t border-border/70 bg-muted/20 px-5 py-3.5">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              取消
            </Button>
            <Button type="submit" disabled={!valid || busy}>
              {busy ? "保存中…" : task ? "保存更改" : "创建任务"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function EditorField({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-xs text-foreground/80">
        {label}
      </Label>
      {children}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <h3 className="text-xs font-medium text-muted-foreground">{children}</h3>
}

function ChoiceButton({
  active,
  icon,
  title,
  description,
  onClick,
}: {
  active: boolean
  icon: React.ReactNode
  title: string
  description: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        active ? "border-foreground/25 bg-muted" : "border-border/70 hover:bg-muted/45"
      )}
    >
      <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span>
        <span className="text-ui-small block font-medium">{title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  )
}

function WorkspaceButton({
  active,
  icon,
  children,
  onClick,
}: {
  active: boolean
  icon: React.ReactNode
  children: React.ReactNode
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-lg px-2.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-3.5",
        active
          ? "bg-background font-medium shadow-sm ring-1 ring-border/70"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {icon}
      {children}
    </button>
  )
}

const weekdayOptions = [
  ["MO", "星期一"],
  ["TU", "星期二"],
  ["WE", "星期三"],
  ["TH", "星期四"],
  ["FR", "星期五"],
  ["SA", "星期六"],
  ["SU", "星期日"],
] as const

const frequencyLabels: Record<Frequency, string> = {
  daily: "每天",
  weekdays: "每个工作日",
  weekly: "每周",
  monthly: "每月",
  once: "仅一次",
  custom: "自定义规则（保持不变）",
}

function buildRecurrence(input: {
  frequency: Frequency
  time: string
  weekday: string
  monthday: string
  onceAt: string
  original?: string
  originalFormat?: "rrule" | "once"
}): { format: "rrule" | "once"; value: string } {
  if (input.frequency === "custom" && input.original && input.originalFormat) {
    return { format: input.originalFormat, value: input.original }
  }
  if (input.frequency === "once")
    return { format: "once", value: new Date(input.onceAt).toISOString() }
  const [hour = "0", minute = "0"] = input.time.split(":")
  const suffix = `BYHOUR=${Number(hour)};BYMINUTE=${Number(minute)}`
  if (input.frequency === "weekdays")
    return { format: "rrule", value: `RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;${suffix}` }
  if (input.frequency === "weekly")
    return { format: "rrule", value: `RRULE:FREQ=WEEKLY;BYDAY=${input.weekday};${suffix}` }
  if (input.frequency === "monthly")
    return {
      format: "rrule",
      value: `RRULE:FREQ=MONTHLY;BYMONTHDAY=${Math.min(31, Math.max(1, Number(input.monthday) || 1))};${suffix}`,
    }
  return { format: "rrule", value: `RRULE:FREQ=DAILY;${suffix}` }
}

function editorSchedule(task: DesktopScheduledTask | null): {
  frequency: Frequency
  time: string
  weekday: string
  monthday: string
  onceAt: string
} {
  if (!task) return { frequency: "daily", time: "09:00", weekday: "MO", monthday: "1", onceAt: "" }
  if (task.recurrenceFormat === "once") {
    const date = new Date(task.recurrence)
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16)
    return { frequency: "once", time: "09:00", weekday: "MO", monthday: "1", onceAt: local }
  }
  const rule = Object.fromEntries(
    task.recurrence
      .replace(/^RRULE:/, "")
      .split(";")
      .map((part) => part.split("=", 2))
  )
  const supportedKeys = new Set(["FREQ", "BYDAY", "BYMONTHDAY", "BYHOUR", "BYMINUTE"])
  const hasUnsupportedParts = Object.keys(rule).some((key) => !supportedKeys.has(key))
  const time = `${String(Number(rule.BYHOUR ?? 0)).padStart(2, "0")}:${String(Number(rule.BYMINUTE ?? 0)).padStart(2, "0")}`
  const weekdays = rule.BYDAY === "MO,TU,WE,TH,FR"
  const frequency: Frequency = hasUnsupportedParts
    ? "custom"
    : rule.FREQ === "MONTHLY"
      ? "monthly"
      : rule.FREQ === "WEEKLY"
        ? weekdays
          ? "weekdays"
          : "weekly"
        : rule.FREQ === "DAILY"
          ? "daily"
          : "custom"
  return {
    frequency,
    time,
    weekday: weekdays ? "MO" : (rule.BYDAY?.split(",")[0] ?? "MO"),
    monthday: rule.BYMONTHDAY ?? "1",
    onceAt: "",
  }
}
