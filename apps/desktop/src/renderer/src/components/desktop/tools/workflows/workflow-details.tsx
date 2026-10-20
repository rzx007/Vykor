import { Bot, CornerDownRight, X, Files, CircleHelp, History } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@renderer/components/motion/tabs"
import { Button } from "@renderer/components/ui/button"
import type { DesktopWorkflowRun, DesktopWorkflowTask } from "@shared/workflow-types"
import type { DesktopSessionTask } from "@shared/session-types"
import { workflowTaskLabel, workflowWaitText } from "./workflow-model"
import { WorkflowStatusIcon } from "./workflow-status-icon"
import { WorkflowDisclosure } from "./workflow-disclosure"
import { WorkflowOutputFiles, WorkflowChangedFiles } from "./workflow-output"
import { AssistantMarkdown } from "../../conversation-page/message/markdown/assistant-markdown"

export function WorkflowDetails({
  run,
  task,
  agentTasks = [],
  onSelect,
  onOpenFile,
  onOpenAgents,
  onOpenReview,
  onClose,
}: {
  run: DesktopWorkflowRun
  task: DesktopWorkflowTask
  agentTasks?: DesktopSessionTask[]
  onSelect(id: string): void
  onOpenFile(path: string): void
  onOpenAgents(taskId: string): void
  onOpenReview(path?: string, rootPath?: string): void
  onClose(): void
}) {
  const agent = agentTasks.find((agent) => agent.id === task.workerTaskId && agent.childSessionId)
  const events = run.events.filter((event) => event.taskId === task.id)
  const wait = workflowWaitText(task, run)
  const elapsed =
    task.startedAt === undefined
      ? null
      : Math.max(0, Math.round(((task.finishedAt ?? Date.now()) - task.startedAt) / 1000))
  return (
    <section className="mt-4 border-t pt-5" aria-label="节点详情">
      <div className="flex items-start gap-2">
        <WorkflowStatusIcon status={task.status} />
        <h3 className="min-w-0 flex-1 text-sm font-semibold break-words">{task.title}</h3>
        <Button
          variant="ghost"
          shape="circle"
          size="icon-sm"
          aria-label="收起节点详情"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <p className="mt-1 pl-6 text-xs text-muted-foreground">
        {workflowTaskLabel(task)}
        {elapsed !== null ? ` · ${elapsed} 秒` : ""}
      </p>
      <Tabs
        defaultValue={task.status === "completed" ? "output" : "overview"}
        variant="pill"
        icons="selected"
        className="mt-4"
      >
        <TabsList aria-label="节点详情视图">
          <TabsTrigger
            value="output"
            aria-label="产出"
            icon={<Files className="size-3.5" strokeWidth={1.75} />}
          >
            产出
          </TabsTrigger>
          <TabsTrigger
            value="overview"
            aria-label="概况"
            icon={<CircleHelp className="size-3.5" strokeWidth={1.75} />}
          >
            概况
          </TabsTrigger>
          <TabsTrigger
            value="activity"
            aria-label="执行记录"
            icon={<History className="size-3.5" strokeWidth={1.75} />}
          >
            执行记录
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="space-y-3 text-sm">
          {task.needsInput ? (
            <div className="space-y-2">
              <p>此任务正在等待你的输入或确认。</p>
              {agent ? (
                <Button
                  variant="default"
                  shape="pill"
                  size="sm"
                  onClick={() => onOpenAgents(agent.id)}
                >
                  <Bot data-icon="inline-start" />
                  前往子 Agent 处理
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  暂未找到对应的子 Agent 会话，可刷新编排后重试。
                </p>
              )}
            </div>
          ) : null}
          {wait ? <p className="text-muted-foreground">{wait}</p> : null}
          {task.error ? (
            <p role="alert" className="break-words whitespace-pre-wrap text-destructive">
              {task.error}
            </p>
          ) : task.summary && task.summary !== `${task.id} finished with status ${task.status}` ? (
            <p className="break-words whitespace-pre-wrap text-muted-foreground">{task.summary}</p>
          ) : null}
          {task.cleanupUnconfirmed ? (
            <p role="alert" className="text-destructive">
              尚未确认子任务已停止。重新执行前，请检查仍在运行的工作及文件改动。
            </p>
          ) : null}
          {task.dependencies.length ? (
            <div>
              <p className="mb-2 text-xs text-muted-foreground">上游任务 · 点击查看返回结果</p>
              {task.dependencies.map((id) => {
                const upstream = run.tasks.find((candidate) => candidate.id === id)
                return (
                  <div key={id} className="mb-3">
                    <Button variant="ghost" shape="pill" size="sm" onClick={() => onSelect(id)}>
                      <CornerDownRight data-icon="inline-start" />
                      {upstream?.title ?? id}
                    </Button>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {upstream ? workflowTaskLabel(upstream) : "状态待确认"}
                    </span>
                  </div>
                )
              })}
            </div>
          ) : null}
          {task.prompt ? (
            <WorkflowDisclosure label="完整任务要求">
              <p className="break-words whitespace-pre-wrap">{task.prompt}</p>
            </WorkflowDisclosure>
          ) : null}
          <WorkflowDisclosure label="任务信息">
            <dl className="space-y-2 text-xs text-muted-foreground">
              <div>
                <dt className="inline">任务 ID：</dt>
                <dd className="inline break-all">{task.id}</dd>
              </div>
              {task.attempts !== undefined ? (
                <div>
                  <dt className="inline">执行次数：</dt>
                  <dd className="inline">{task.attempts}</dd>
                </div>
              ) : null}
              {task.model ? (
                <div>
                  <dt className="inline">模型：</dt>
                  <dd className="inline">{task.model}</dd>
                </div>
              ) : null}
              {task.writeScope.length ? (
                <div>
                  <dt className="inline">修改范围：</dt>
                  <dd className="inline">{task.writeScope.join("、")}</dd>
                </div>
              ) : null}
            </dl>
          </WorkflowDisclosure>
        </TabsContent>
        <TabsContent value="activity" className="space-y-3 text-sm">
          {agent ? (
            <Button variant="outline" shape="pill" size="sm" onClick={() => onOpenAgents(agent.id)}>
              <Bot data-icon="inline-start" />
              查看子 Agent 完整记录
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              当前没有可打开的子 Agent 会话，以下保留编排事件和任务结果。
            </p>
          )}
          {events.length ? (
            <ol className="space-y-3">
              {events.map((event, index) => (
                <li key={`${event.timestamp}:${index}`} className="flex gap-3 text-xs">
                  <time className="shrink-0 text-muted-foreground tabular-nums">
                    {new Date(event.timestamp).toLocaleTimeString()}
                  </time>
                  <span className="min-w-0 break-words whitespace-pre-wrap">
                    {event.summary ?? eventLabel(event.type)}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-muted-foreground">尚无节点事件。</p>
          )}
          {run.eventsTruncated ? (
            <p className="text-xs text-muted-foreground">
              此处显示最近 200 条编排事件中的相关记录。
            </p>
          ) : null}
        </TabsContent>
        <TabsContent value="output" className="space-y-3 text-sm">
          <WorkflowOutputFiles tasks={[task]} onOpenFile={onOpenFile} compact />
          <WorkflowChangedFiles task={task} onOpenFile={onOpenFile} onOpenReview={onOpenReview} />
          {task.result ? (
            <WorkflowDisclosure label="完整返回结果">
              <AssistantMarkdown
                text={task.result}
                streaming={false}
                animateInitialText={false}
                onOpenFile={onOpenFile}
                fileLinkMode="text"
              />
            </WorkflowDisclosure>
          ) : (
            <p className="text-xs text-muted-foreground">尚无任务结果。</p>
          )}
        </TabsContent>
      </Tabs>
    </section>
  )
}

export function eventLabel(type: string): string {
  return (
    (
      {
        workflow_started: "编排开始",
        task_started: "任务开始",
        task_progress: "任务更新",
        task_blocked: "等待修改范围",
        task_finished: "任务结束",
        workflow_finished: "编排结束",
        workflow_cancelled: "编排已停止",
        workflow_budget_conserving: "已调整预算使用策略",
        workflow_budget_exceeded: "已达到预算限制",
      } as Record<string, string>
    )[type] ?? type
  )
}
