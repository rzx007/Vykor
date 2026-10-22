import { ChevronDown, Goal, Hourglass, Pause, Pencil, Play, Trash2, X } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { Button } from "@renderer/components/ui/button"
import { ButtonGroup } from "@renderer/components/ui/button-group"
import { Textarea } from "@renderer/components/ui/textarea"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@renderer/components/ui/alert-dialog"
import type { DesktopSessionGoalActionInput, SessionGoal } from "@shared/session-types"
import { goalStopReasonLabel } from "./goal-stop-reason-label"

const labels: Record<SessionGoal["status"], string> = {
  active: "正在推进目标",
  waiting_user: "目标等待你的处理",
  blocked: "目标暂时受阻",
  paused: "已暂停的目标",
  completed: "目标已完成",
  cancelled: "目标已取消",
}

export function GoalBanner({
  goal,
  busy,
  stopping,
  userWorkPending = false,
  editing = false,
  onAction,
  onEdit,
  onDismiss,
}: {
  goal: SessionGoal
  busy: boolean
  stopping: boolean
  userWorkPending?: boolean
  editing?: boolean
  onAction: (
    input: Pick<
      DesktopSessionGoalActionInput,
      "action" | "additionalAutoTurns" | "questionId" | "response" | "tokenBudget" | "objectiveVersion"
    >
  ) => void
  onEdit: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [metricsExpanded, setMetricsExpanded] = useState(false)
  const metricsId = useId()
  const detailsId = useId()
  const [cancelOpen, setCancelOpen] = useState(false)
  const [additionalAutoTurns, setAdditionalAutoTurns] = useState(20)
  const [response, setResponse] = useState("")
  useEffect(() => setResponse(""), [goal.id, goal.objectiveVersion, goal.wait?.kind === "user" ? goal.wait.questionId : undefined])
  const budgetClosed = goal.tokenBudget !== undefined && (goal.usage.incomplete || goal.usage.knownTokens >= goal.tokenBudget)
  const stopLabel = goalStopReasonLabel(goal)
  const terminal = goal.status === "completed" || goal.status === "cancelled"
  const approvalWait = goal.status === "waiting_user" && goal.wait?.kind === "approval"
  const queued = Boolean(goal.queuedResume)
  const canResume = goal.status === "paused" || goal.status === "blocked" || approvalWait
  const resumeLabel = queued ? "已排队，等待处理" : userWorkPending ? "排队继续" : approvalWait ? "批准后继续" : goal.status === "blocked" ? "检查并继续" : "继续"
  const explanation = goal.wait?.kind === "user" ? goal.wait.question : goal.reason
  const hasExplanation = Boolean(stopLabel || explanation || goal.wait?.kind === "approval")
  const explanationLabel = goal.status === "completed" ? "完成说明" : goal.status === "cancelled" ? "取消说明" : "状态说明"
  const quotaExhausted = goal.maxAutoTurns > 0 && goal.autoTurnsUsed >= goal.maxAutoTurns
  const validQuota =
    Number.isSafeInteger(additionalAutoTurns) &&
    additionalAutoTurns > 0 &&
    goal.maxAutoTurns + additionalAutoTurns <= 1000
  const resume = (): void => {
    if (busy || stopping || queued) return
    onAction({ action: "resume", ...(quotaExhausted ? { additionalAutoTurns } : {}) })
  }
  return (
    <div className="rounded-xl border border-border/70 bg-background px-3 text-sm">
      <div className="flex min-h-12 items-center gap-2 py-2">
        <Goal strokeWidth={1.75} className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">
          {stopping ? "正在停止目标" : labels[goal.status]}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{goal.objective}</span>
        <div className="flex shrink-0 items-center gap-2">
          {goal.status === "active" && !editing ? (
            <Button
              type="button"
              variant="control"
              size="icon"
              shape="circle"
              disabled={busy || stopping}
              aria-label="暂停目标"
              title="暂停目标"
              onClick={() => onAction({ action: "pause" })}
            >
              <Pause />
            </Button>
          ) : null}
          {!editing && (canResume || queued) ? (
            <Button
              type="button"
              variant="control"
              size={queued || userWorkPending ? "sm" : "icon"}
              shape={queued || userWorkPending ? "pill" : "circle"}
              aria-label={resumeLabel}
              title={resumeLabel}
              disabled={busy || stopping || queued || (approvalWait && budgetClosed)}
              onClick={() => {
                if (budgetClosed) { setExpanded(true); setMetricsExpanded(true) }
                else if (quotaExhausted) setExpanded(true)
                else resume()
              }}
            >
              {queued || userWorkPending ? <Hourglass /> : <Play />}
              {queued || userWorkPending ? <span>{resumeLabel}</span> : null}
            </Button>
          ) : null}
          <ButtonGroup variant="toolbar" aria-label="目标操作">
            {queued && !editing ? <Button type="button" variant="ghost" size="icon-sm" shape="circle"
              aria-label="取消排队" title="取消排队继续" disabled={busy || stopping}
              onClick={() => onAction({ action: "cancel_resume" })}><X /></Button> : null}
            {!terminal && !editing ? <Button type="button" variant="ghost" size="icon-sm" shape="circle"
              aria-label="编辑目标" title="编辑目标" disabled={busy || stopping} onClick={onEdit}><Pencil /></Button> : null}
            {!editing ? <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              shape="circle"
              aria-label={expanded ? "收起目标详情" : "展开目标详情"}
              title={expanded ? "收起目标详情" : "展开目标详情"}
              aria-expanded={expanded}
              aria-controls={detailsId}
              onClick={() => { setExpanded(!expanded); setMetricsExpanded(false) }}
            >
              <ChevronDown className={expanded ? "rotate-180" : undefined} />
            </Button> : null}
            {terminal ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                shape="circle"
                aria-label="收起目标"
                title="收起目标"
                onClick={onDismiss}
              >
                <X />
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                shape="circle"
                disabled={busy}
                aria-label="取消目标"
                title="取消目标"
                onClick={() => setCancelOpen(true)}
              >
                <Trash2 />
              </Button>
            )}
          </ButtonGroup>
        </div>
      </div>
      {!editing && !terminal && !expanded && hasExplanation ? (
        <div className="pb-3 text-sm leading-relaxed break-words text-muted-foreground">
          <div className={goal.wait?.kind === "user" ? undefined : "line-clamp-2"}>
          {stopLabel ? <span>{stopLabel}{explanation ? "：" : ""}</span> : null}
          {explanation}
          {goal.wait?.kind === "approval" ? " 请处理上方对应的授权请求。" : null}
          </div>
        </div>
      ) : null}
      {expanded && !editing ? (
        <div id={detailsId} className="space-y-3 border-t border-border/60 py-3">
          <div role="region" aria-label="目标内容" tabIndex={0}
            className="max-h-60 overflow-y-auto overscroll-contain rounded-sm pr-2 leading-relaxed break-words whitespace-pre-wrap outline-none focus-visible:outline-2 focus-visible:outline-ring">
            {goal.objective}
          </div>
          {hasExplanation ? <section aria-label={explanationLabel} className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground">{explanationLabel}</h3>
            <div tabIndex={0} className="max-h-40 overflow-y-auto overscroll-contain rounded-sm pr-2 text-sm leading-relaxed break-words whitespace-pre-wrap text-muted-foreground outline-none focus-visible:outline-2 focus-visible:outline-ring">
              {stopLabel ? <span>{stopLabel}{explanation ? "：" : ""}</span> : null}
              {explanation}
              {goal.wait?.kind === "approval" ? " 请处理上方对应的授权请求。" : null}
            </div>
          </section> : null}
          {quotaExhausted && !terminal ? (
            <div className="flex items-center gap-2 text-xs">
              <label>
                增加自动续跑次数{" "}
                <input
                  aria-label="增加自动续跑次数"
                  type="number"
                  min={1}
                  max={1000 - goal.maxAutoTurns}
                  step={1}
                  disabled={busy || queued}
                  value={additionalAutoTurns}
                  onChange={(event) => setAdditionalAutoTurns(Number(event.target.value))}
                  className="w-16 rounded border px-1"
                />
              </label>
              {canResume ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || stopping || queued || !validQuota || budgetClosed}
                  onClick={resume}
                >
                  {userWorkPending ? "增加次数并排队" : "增加次数并继续"}
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="border-t border-border/60 pt-2">
            <Button type="button" variant="ghost" size="sm" shape="pill" className="gap-1.5 text-muted-foreground"
              aria-expanded={metricsExpanded} aria-controls={metricsId} onClick={() => setMetricsExpanded(!metricsExpanded)}>
              <ChevronDown strokeWidth={1.75} className={metricsExpanded ? "rotate-180" : undefined} />
              运行详情
            </Button>
            {metricsExpanded ? (
              <div id={metricsId} className="space-y-3 px-2 pt-3">
                <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs leading-5 text-muted-foreground [&>dd]:min-w-0 [&>dd]:break-words [&>dd]:tabular-nums">
                  <dt>目标版本</dt><dd>{goal.objectiveVersion}</dd>
                  <dt>自动续跑</dt><dd>{goal.autoTurnsUsed} 次{goal.maxAutoTurns > 0 ? ` / 限额 ${goal.maxAutoTurns} 次` : " · 不限轮数"}</dd>
                  <dt>已用 Token</dt><dd>{goal.usage.incomplete ? "至少 " : ""}{goal.usage.knownTokens.toLocaleString()} Token</dd>
                  <dt>Token 上限</dt><dd>{goal.tokenBudget === undefined ? "未设置" : `${goal.tokenBudget.toLocaleString()} Token`}</dd>
                  <dt>用量状态</dt><dd>{goal.usage.incomplete || goal.usage.inFlightAttempts > 0
                    ? `未知 ${goal.usage.unknownAttempts} 次 · 部分 ${goal.usage.partialAttempts} 次 · 进行中 ${goal.usage.inFlightAttempts} 次` : "已确认"}</dd>
                  <dt>累计耗时</dt><dd>{Math.round(goal.usage.runTimeMs / 1000)} 秒</dd>
                  {goal.stopReason?.detail ? <><dt>停止详情</dt><dd className="max-h-32 overflow-y-auto whitespace-pre-wrap">{goal.stopReason.detail}</dd></> : null}
                </dl>
                {!terminal && goal.tokenBudget !== undefined ? <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="outline" size="sm" shape="pill" disabled={busy || stopping}
                    onClick={() => onAction({ action: "budget", tokenBudget: null })}>解除 Token 限制</Button>
                  <span className="text-xs text-muted-foreground">解除后不会自动继续。</span>
                </div> : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {!editing && goal.status === "waiting_user" && goal.wait?.kind === "user" ? (
        <form
          key={goal.wait.questionId}
          className="flex flex-col gap-2 border-t border-border/60 py-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (
              goal.wait?.kind !== "user" ||
              busy || stopping || queued ||
              budgetClosed || !response.trim() ||
              goal.wait.objectiveVersion !== goal.objectiveVersion ||
              (quotaExhausted && (!expanded || !validQuota))
            )
              return
            onAction({
              action: "resume",
              questionId: goal.wait.questionId,
              objectiveVersion: goal.wait.objectiveVersion,
              response: response.trim(),
              ...(quotaExhausted ? { additionalAutoTurns } : {}),
            })
          }}
        >
          <Textarea
            aria-label="回答目标问题"
            placeholder="补充你的说明，可分行填写"
            rows={2}
            disabled={busy || stopping || queued}
            value={response}
            onChange={(event) => setResponse(event.target.value)}
            className="max-h-36 min-h-20 resize-y"
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
            type="submit"
            size="sm"
            shape="pill"
            disabled={busy || stopping || queued || budgetClosed || !response.trim() || goal.wait.objectiveVersion !== goal.objectiveVersion || (quotaExhausted && (!expanded || !validQuota))}
          >
            {busy ? "正在提交…" : queued ? "已排队，等待处理" : userWorkPending ? "排队继续" : "补充并继续"}
          </Button></div>
          {quotaExhausted && !expanded ? (
            <span className="text-xs">自动续跑次数已用完，请先展开详情增加次数。</span>
          ) : null}
          {budgetClosed ? <span className="text-xs text-muted-foreground">Token 限制尚未解除，请先在运行详情中调整。</span> : null}
        </form>
      ) : null}
      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>取消这个目标？</AlertDialogTitle>
            <AlertDialogDescription>将停止此目标的后续执行，保留会话和已经产生的文件。取消后可以新建目标。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>保留目标</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => {
              if (busy) return
              setCancelOpen(false)
              onAction({ action: "cancel" })
            }}>取消目标</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
