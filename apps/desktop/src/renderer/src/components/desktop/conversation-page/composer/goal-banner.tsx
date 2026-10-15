import { ChevronDown, Goal, Pause, Trash2, X } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { Button } from "@renderer/components/ui/button"
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
  editing = false,
  onAction,
  onEdit,
  onDismiss,
}: {
  goal: SessionGoal
  busy: boolean
  stopping: boolean
  editing?: boolean
  onAction: (
    input: Pick<
      DesktopSessionGoalActionInput,
      "action" | "additionalAutoTurns" | "questionId" | "response" | "tokenBudget" | "objectiveVersion" | "reprepare"
    >
  ) => void
  onEdit: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [progressExpanded, setProgressExpanded] = useState(false)
  const [metricsExpanded, setMetricsExpanded] = useState(false)
  const progressId = useId()
  const metricsId = useId()
  const [cancelOpen, setCancelOpen] = useState(false)
  const [additionalAutoTurns, setAdditionalAutoTurns] = useState(20)
  const [response, setResponse] = useState("")
  useEffect(() => setResponse(""), [goal.wait?.kind === "user" ? goal.wait.questionId : undefined])
  const budgetClosed = goal.tokenBudget !== undefined && (goal.usage.incomplete || goal.usage.knownTokens >= goal.tokenBudget)
  const saveAnswerOnly = budgetClosed && goal.phase === "preparing" && goal.wait?.kind === "user" && goal.wait.purpose === "clarification"
  const stopLabel = goalStopReasonLabel(goal)
  const terminal = goal.status === "completed" || goal.status === "cancelled"
  const preparationFailed = goal.phase === "preparing" && goal.stopReason?.code === "preparation_incomplete"
  const requirementStatuses = new Map(goal.assessment?.requirements?.map(item => [item.requirementId, item.status]))
  const assessedCount = goal.requirements.filter(item => requirementStatuses.has(item.id)).length
  const satisfiedCount = goal.requirements.filter(item => requirementStatuses.get(item.id) === "satisfied").length
  const quotaExhausted = goal.phase === "executing" && goal.maxAutoTurns > 0 && goal.autoTurnsUsed >= goal.maxAutoTurns
  const validQuota =
    Number.isSafeInteger(additionalAutoTurns) &&
    additionalAutoTurns > 0 &&
    goal.maxAutoTurns + additionalAutoTurns <= 1000
  const resume = (): void =>
    onAction({ action: "resume", ...(goal.status === "blocked" ? { response: response.trim() } : {}), ...(quotaExhausted ? { additionalAutoTurns } : {}) })
  return (
    <div className="rounded-xl border border-border/70 bg-background px-3 text-sm">
      <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 py-1">
        <Goal strokeWidth={1.75} className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">
          {stopping ? "正在停止目标" : goal.status === "active" && goal.phase === "preparing" ? "正在整理目标"
            : goal.status === "waiting_user" && goal.wait?.kind === "user" && goal.wait.purpose === "clarification" ? "需要补充信息"
            : preparationFailed ? "目标准备未完成" : labels[goal.status]}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{goal.objective}</span>
        {goal.status === "active" && !editing ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            shape="circle"
            disabled={busy}
            aria-label="暂停目标"
            onClick={() => onAction({ action: "pause" })}
          >
            <Pause />
          </Button>
        ) : null}
        {!editing && (goal.status === "paused" || goal.status === "blocked") ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy || stopping}
            onClick={() => {
              if (budgetClosed) { setExpanded(true); setMetricsExpanded(true) }
              else if (quotaExhausted || (goal.status === "blocked" && !response.trim())) setExpanded(true)
              else if (preparationFailed) onAction({ action: "resume", reprepare: true })
              else resume()
            }}
          >
            {preparationFailed ? "重新整理" : goal.status === "blocked" ? "检查并继续" : "继续"}
          </Button>
        ) : null}
        {!terminal && !editing ? <Button type="button" variant="ghost" size="sm" shape="pill" disabled={busy || stopping} onClick={onEdit}>编辑目标</Button> : null}
        {!editing ? <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          shape="circle"
          aria-label={expanded ? "收起目标详情" : "展开目标详情"}
          aria-expanded={expanded}
          onClick={() => { setExpanded(!expanded); setProgressExpanded(false); setMetricsExpanded(false) }}
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
      </div>
      {!editing && (stopLabel || goal.reason || goal.wait) ? (
        <div className="pb-3 text-sm leading-relaxed break-words text-muted-foreground">
          {stopLabel && !preparationFailed ? <span>{stopLabel}{goal.reason || goal.wait ? "：" : ""}</span> : null}
          {goal.wait?.kind === "user" ? goal.wait.question : goal.reason}
          {goal.wait?.kind === "approval" ? " 请处理上方对应的授权请求。" : null}
        </div>
      ) : null}
      {expanded && !editing ? (
        <div className="space-y-3 border-t py-3">
          <div role="region" aria-label="目标内容" tabIndex={0}
            className="max-h-60 overflow-y-auto overscroll-contain rounded-sm pr-2 leading-relaxed break-words whitespace-pre-wrap outline-none focus-visible:outline-2 focus-visible:outline-ring">
            {goal.objective}
          </div>
          {goal.phase === "preparing" && (goal.status === "paused" || goal.status === "blocked") ? (
            <Button type="button" variant="outline" size="sm" disabled={busy || stopping || budgetClosed} onClick={() => onAction({ action: "resume", reprepare: true })}>重新整理目标</Button>
          ) : null}
          {goal.status === "blocked" ? <div className="flex gap-2"><input aria-label="阻塞条件变化" placeholder="说明什么条件发生了变化" value={response} onChange={event => setResponse(event.target.value)} className="min-w-0 flex-1 rounded border px-2 py-1" />
            <Button type="button" variant="outline" size="sm" disabled={busy || stopping || budgetClosed || !response.trim()} onClick={resume}>检查并继续</Button></div> : null}
          {goal.requirements.length > 0 || goal.evidence.length > 0 || goal.assessment?.remainingWork?.length ? (
            <div className="border-t border-border/60 pt-2">
              <Button type="button" variant="ghost" size="sm" shape="pill" className="w-full justify-start gap-1.5 text-muted-foreground"
                aria-label="验收进度" aria-expanded={progressExpanded} aria-controls={progressId} onClick={() => setProgressExpanded(!progressExpanded)}>
                <ChevronDown strokeWidth={1.75} className={progressExpanded ? "rotate-180" : undefined} />
                <span className="flex-1 text-left">验收进度</span>
                {goal.requirements.length > 0 ? <span className="text-xs tabular-nums">
                  {assessedCount > 0 ? `${satisfiedCount} / ${goal.requirements.length} 已满足` : `${goal.requirements.length} 项待检查`}
                </span> : null}
              </Button>
              {progressExpanded ? (
                <div id={progressId} role="region" aria-label="验收明细" tabIndex={0}
                  className="mt-3 max-h-72 space-y-4 overflow-y-auto overscroll-contain rounded-sm px-2 leading-6 break-words outline-none focus-visible:outline-2 focus-visible:outline-ring">
                  {goal.requirements.length > 0 ? <div className="space-y-2">
                    <p className="font-medium">完成条件</p>
                    <ol className="list-decimal space-y-3 pl-5 marker:text-muted-foreground">
                      {goal.requirements.map(item => {
                        const status = requirementStatuses.get(item.id)
                        return <li key={item.id}>
                          <div className="flex min-w-0 items-start gap-3">
                            <span className="min-w-0 flex-1">{item.text}</span>
                            <span className="shrink-0 text-xs leading-6 text-muted-foreground">
                              {status === "satisfied" ? "已满足" : status === "needs_user" ? "待验收" : status === "incomplete" ? "未完成" : "待检查"}
                            </span>
                          </div>
                        </li>
                      })}
                    </ol>
                  </div> : null}
                  {goal.assessment?.remainingWork?.length ? <div className="space-y-2">
                    <p className="font-medium">剩余工作</p>
                    <ul className="list-disc space-y-2 pl-5 text-muted-foreground">
                      {goal.assessment.remainingWork.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
                    </ul>
                  </div> : null}
                  {goal.evidence.length > 0 ? <div className="space-y-2">
                    <p className="font-medium">验证记录</p>
                    <ul className="list-disc space-y-2 pl-5 text-muted-foreground">
                      {goal.evidence.map((item, index) => <li key={index}>{item}</li>)}
                    </ul>
                  </div> : null}
                </div>
              ) : null}
            </div>
          ) : null}
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
                  disabled={busy}
                  value={additionalAutoTurns}
                  onChange={(event) => setAdditionalAutoTurns(Number(event.target.value))}
                  className="w-16 rounded border px-1"
                />
              </label>
              {goal.status === "paused" || goal.status === "blocked" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || stopping || !validQuota || budgetClosed}
                  onClick={resume}
                >
                  增加次数并继续
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
                  <dt>目标版本</dt><dd>{goal.objectiveVersion}{goal.versionSummary ? ` · ${goal.versionSummary.changeReason}` : ""}</dd>
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
              busy || stopping ||
              (goal.wait.purpose === "clarification" && !response.trim()) ||
              (goal.wait.purpose === "clarification" && quotaExhausted && (!expanded || !validQuota))
            )
              return
            onAction({
              action: goal.wait.purpose === "acceptance" ? "confirm" : "resume",
              questionId: goal.wait.questionId,
              objectiveVersion: goal.wait.objectiveVersion,
              ...(goal.wait.purpose === "clarification" ? { response: response.trim() } : {}),
              ...(goal.wait.purpose === "clarification" && quotaExhausted ? { additionalAutoTurns } : {}),
            })
          }}
        >
          {goal.wait.purpose === "clarification" ? <Textarea
            aria-label="回答目标问题"
            placeholder="补充你的说明，可分行填写"
            rows={2}
            disabled={busy || stopping}
            value={response}
            onChange={(event) => setResponse(event.target.value)}
            className="max-h-36 min-h-20 resize-y"
          /> : <span className="min-w-0 text-xs">{goal.wait.requirementIds?.map(id => goal.requirements.find(item => item.id === id)?.text).join("；")}</span>}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {saveAnswerOnly ? <span className="mr-auto text-xs text-muted-foreground">补充内容会先保存，调整预算后再继续。</span> : null}
            <Button
            type="submit"
            size="sm"
            shape="pill"
            disabled={busy || stopping || (goal.wait.purpose === "clarification" && (!response.trim() || (quotaExhausted && (!expanded || !validQuota))))}
          >
            {goal.wait.purpose === "acceptance" ? "结果满足所列条件" : busy ? "正在提交…" : saveAnswerOnly ? "保存补充" : "补充并继续"}
          </Button></div>
          {goal.wait.purpose === "clarification" && quotaExhausted && !expanded ? (
            <span className="text-xs">自动续跑次数已用完，请先展开详情增加次数。</span>
          ) : null}
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
