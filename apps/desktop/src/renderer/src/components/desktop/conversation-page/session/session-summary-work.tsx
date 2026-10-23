import { useSyncExternalStore, type ReactNode } from "react"
import { GitBranch, PanelsTopLeft, SquareTerminal } from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import type { DesktopTerminalRecord } from "@shared/terminal-types"
import type { DesktopWorkflowRun } from "@shared/workflow-types"
import type { ResidentAppPage } from "../../shell/plugin-apps/page-manager"
import { workflowProgress, workflowStatus } from "../../tools/workflows/workflow-model"

function WorkRow({
  title,
  description,
  icon,
  onOpen,
}: {
  title: string
  description: string
  icon: ReactNode
  onOpen(): void
}) {
  return (
    <Button
      variant="ghost"
      className="h-auto min-h-8 w-full justify-start gap-2 px-1.5 py-1.5 text-left font-normal"
      onClick={onOpen}
      aria-label={`打开${title}`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
      <span className="max-w-1/2 truncate text-xs text-muted-foreground" title={description}>
        {description}
      </span>
    </Button>
  )
}

function AppRow({ page, onOpen }: { page: ResidentAppPage; onOpen(): void }) {
  const state = useSyncExternalStore(page.controller.subscribe, page.controller.snapshot)
  const description = !state.online
    ? "连接已断开 · 草稿保留"
    : state.availability.reason === "action-unconfirmed"
      ? "操作结果待核实 · 草稿保留"
      : state.app.status !== "open"
        ? "应用已关闭或授权已撤销"
        : page.initializationError
          ? "应用加载失败，可打开查看"
          : !page.modes?.length
            ? "正在打开"
            : !state.availability.canInvokeTools
              ? "只读 · 草稿保留"
              : "已打开"
  return (
    <WorkRow
      title={page.title}
      description={description}
      icon={<PanelsTopLeft />}
      onOpen={onOpen}
    />
  )
}

export function SessionSummaryWork({
  pages,
  runs,
  terminals,
  terminalError,
  workflowError,
  workflowReconnecting,
  onOpenApp,
  onOpenWorkflow,
  onOpenTerminal,
}: {
  pages: ResidentAppPage[]
  runs: DesktopWorkflowRun[]
  terminals: DesktopTerminalRecord[]
  terminalError: string | null
  workflowError?: string | null
  workflowReconnecting?: boolean
  onOpenApp(page: ResidentAppPage): void
  onOpenWorkflow(id: string): void
  onOpenTerminal?: (id: string) => void
}) {
  return (
    <>
      {pages.length > 0 && (
        <section aria-label="聊天应用" className="flex flex-col gap-1 py-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">应用</span>
          </div>
          {pages.map((page) => (
            <AppRow key={page.id} page={page} onOpen={() => onOpenApp(page)} />
          ))}
        </section>
      )}
      {(runs.length > 0 ||
        terminals.length > 0 ||
        workflowError ||
        terminalError) && (
        <section aria-label="聊天工作流和长任务" className="flex flex-col gap-1 py-3">
          <span className="text-xs text-muted-foreground">工作流与长任务</span>
          {workflowReconnecting && (
            <p role="status" className="text-xs text-muted-foreground">
              工作流正在重新连接，显示上次状态
            </p>
          )}
          {workflowError && (
            <p role="status" className="text-xs text-destructive">
              工作流状态暂不可用：{workflowError}
            </p>
          )}
          {runs.map((run) => (
            <WorkRow
              key={run.id}
              title={run.title || "工作流"}
              description={[
                workflowStatus(run),
                run.detailsAvailable && run.tasks.length > 0 ? workflowProgress(run) : "",
              ]
                .filter(Boolean)
                .join(" · ")}
              icon={<GitBranch />}
              onOpen={() => onOpenWorkflow(run.id)}
            />
          ))}
          {terminals.map((terminal) => (
            <WorkRow
              key={terminal.id}
              title={terminal.name || terminal.command || "终端任务"}
              description={`终端 · ${{ running: "运行中", stopping: "正在停止", completed: "已完成", failed: "执行失败", killed: "已停止" }[terminal.status] ?? "状态待确认"}`}
              icon={<SquareTerminal />}
              onOpen={() => onOpenTerminal?.(terminal.id)}
            />
          ))}
          {terminalError && (
            <p role="status" className="text-xs text-destructive">
              终端状态暂不可用：{terminalError}
            </p>
          )}
        </section>
      )}
    </>
  )
}
