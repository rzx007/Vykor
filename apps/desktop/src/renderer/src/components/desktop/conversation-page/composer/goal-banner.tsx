import { ChevronDown, Goal, Pause, Trash2, X } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@renderer/components/ui/button"
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
  onAction,
  onEdit,
  onDismiss,
}: {
  goal: SessionGoal
  busy: boolean
  stopping: boolean
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
  const [additionalAutoTurns, setAdditionalAutoTurns] = useState(20)
  const [response, setResponse] = useState("")
  useEffect(() => setResponse(""), [goal.wait?.kind === "user" ? goal.wait.questionId : undefined])
  const [budgetDraft, setBudgetDraft] = useState(String(goal.tokenBudget ?? ""))
  useEffect(() => setBudgetDraft(String(goal.tokenBudget ?? "")), [goal.id, goal.tokenBudget])
  const budgetValue = Number(budgetDraft)
  const validBudget = /^\d+$/.test(budgetDraft) && Number.isSafeInteger(budgetValue) && budgetValue > 0 && budgetValue >= goal.usage.knownTokens
  const budgetClosed = goal.tokenBudget !== undefined && (goal.usage.incomplete || goal.usage.knownTokens >= goal.tokenBudget)
  const stopLabel = goalStopReasonLabel(goal)
  const terminal = goal.status === "completed" || goal.status === "cancelled"
  const quotaExhausted = goal.phase === "executing" && goal.maxAutoTurns > 0 && goal.autoTurnsUsed >= goal.maxAutoTurns
  const validQuota =
    Number.isSafeInteger(additionalAutoTurns) &&
    additionalAutoTurns > 0 &&
    goal.maxAutoTurns + additionalAutoTurns <= 1000
  const resume = (): void =>
    onAction({ action: "resume", ...(goal.status === "blocked" ? { response: response.trim() } : {}), ...(quotaExhausted ? { additionalAutoTurns } : {}) })
  return (
    <div className="rounded-xl border border-border/70 bg-background/95 px-3 text-sm shadow-sm">
      <div className="flex min-h-10 items-center gap-2">
        <Goal className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">
          {stopping ? "正在停止目标" : goal.status === "active" && goal.phase === "preparing" ? "正在整理目标" : labels[goal.status]}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{goal.objective}</span>
        {goal.status === "active" ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={busy}
            aria-label="暂停目标"
            onClick={() => onAction({ action: "pause" })}
          >
            <Pause />
          </Button>
        ) : null}
        {goal.status === "paused" || goal.status === "blocked" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy || stopping}
            onClick={() => (quotaExhausted || budgetClosed || (goal.status === "blocked" && !response.trim()) ? setExpanded(true) : resume())}
          >
            {goal.status === "blocked" ? "检查并继续" : "继续"}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={expanded ? "收起目标详情" : "展开目标详情"}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronDown />
        </Button>
        {terminal ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="收起目标"
            onClick={onDismiss}
          >
            <X />
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={busy}
            aria-label="取消目标"
            onClick={() => onAction({ action: "cancel" })}
          >
            <Trash2 />
          </Button>
        )}
      </div>
      {stopLabel || goal.reason || goal.wait ? (
        <div className="pb-2 text-xs text-muted-foreground">
          {stopLabel ? <span>{stopLabel}{goal.reason || goal.wait ? "：" : ""}</span> : null}
          {goal.wait?.kind === "user" ? goal.wait.question : goal.reason}
          {goal.wait?.kind === "approval" ? " 请处理上方对应的授权请求。" : null}
        </div>
      ) : null}
      {expanded ? (
        <div className="space-y-3 border-t py-3">
          <p className="break-words whitespace-pre-wrap">{goal.objective}</p>
          {goal.versionSummary ? <p className="text-xs text-muted-foreground">版本 {goal.objectiveVersion} · {goal.versionSummary.changeReason}</p> : null}
          {goal.phase === "preparing" && (goal.status === "paused" || goal.status === "blocked") ? (
            <Button type="button" variant="outline" size="sm" disabled={busy || stopping || budgetClosed} onClick={() => onAction({ action: "resume", reprepare: true })}>重新整理目标</Button>
          ) : null}
          {goal.status === "blocked" ? <div className="flex gap-2"><input aria-label="阻塞条件变化" placeholder="说明什么条件发生了变化" value={response} onChange={event => setResponse(event.target.value)} className="min-w-0 flex-1 rounded border px-2 py-1" />
            <Button type="button" variant="outline" size="sm" disabled={busy || stopping || budgetClosed || !response.trim()} onClick={resume}>检查并继续</Button></div> : null}
          {goal.stopReason?.detail ? <p className="break-words text-xs text-muted-foreground">{goal.stopReason.detail}</p> : null}
          <p className="text-xs text-muted-foreground">
            自动续跑 {goal.autoTurnsUsed} 次{goal.maxAutoTurns > 0 ? ` / 限额 ${goal.maxAutoTurns} 次` : " · 不限轮数"}
          </p>
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>{goal.usage.incomplete ? "至少使用" : "已知使用"} {goal.usage.knownTokens.toLocaleString()} Token{goal.usage.incomplete ? "，用量不完整" : ""}</p>
            <p>{goal.tokenBudget === undefined ? "未设置 Token 限制" : `总预算 ${goal.tokenBudget.toLocaleString()} Token`}</p>
            <p>未知 {goal.usage.unknownAttempts} 次 · 部分用量 {goal.usage.partialAttempts} 次 · 进行中 {goal.usage.inFlightAttempts} 次</p>
            <p>累计运行耗时 {Math.round(goal.usage.runTimeMs / 1000)} 秒</p>
            <p>达到已知预算后停止新增工作，可能存在已派发用量。</p>
          </div>
          {!terminal ? (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <label>Token 总预算 <input aria-label="修改 Token 总预算" type="text" inputMode="numeric" placeholder="正整数"
                value={budgetDraft} disabled={busy} onChange={(event) => setBudgetDraft(event.target.value)} className="w-24 rounded border px-1" /></label>
              <Button type="button" variant="outline" size="sm" disabled={busy || !validBudget} onClick={() => onAction({ action: "budget", tokenBudget: budgetValue })}>保存总预算</Button>
              {goal.tokenBudget !== undefined ? <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => onAction({ action: "budget", tokenBudget: null })}>解除 Token 限制</Button> : null}
              <span className="text-muted-foreground">保存后不会自动继续。</span>
            </div>
          ) : null}
          {goal.evidence.length > 0 ? (
            <ul className="list-disc space-y-1 pl-4 text-xs">
              {goal.evidence.map((item, index) => (
                <li key={index} className="break-words">
                  {item}
                </li>
              ))}
            </ul>
          ) : null}
          {goal.requirements.length ? (
            <div className="space-y-1 text-xs">
              <p className="font-medium">完成条件</p>
              <ul className="space-y-1">
                {goal.requirements.map((item) => {
                  const status = goal.assessment?.requirements?.find(value => value.requirementId === item.id)?.status ?? "incomplete"
                  return <li key={item.id} className="flex min-w-0 gap-1.5">
                    <span className="min-w-0 break-words">{item.id}：{item.text}</span>
                    <span className="shrink-0 text-muted-foreground">
                      ：
                      {status === "satisfied"
                        ? "已满足"
                        : status === "needs_user"
                          ? "待验收"
                          : "未完成"}
                    </span>
                  </li>
                })}
              </ul>
            </div>
          ) : null}
          {goal.assessment?.remainingWork?.length ? (
            <div className="space-y-1 text-xs text-muted-foreground">
              {goal.assessment.remainingWork.map((item, index) => (
                <p key={`${item}-${index}`} className="break-words">
                  剩余工作：{item}
                </p>
              ))}
            </div>
          ) : null}
          {!terminal ? (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onEdit}>
              编辑目标
            </Button>
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
        </div>
      ) : null}
      {goal.status === "waiting_user" && goal.wait?.kind === "user" ? (
        <form
          key={goal.wait.questionId}
          className="flex flex-wrap items-center gap-2 border-t py-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (
              goal.wait?.kind !== "user" ||
              busy ||
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
          {goal.wait.purpose === "clarification" ? <input
            aria-label="回答目标问题"
            placeholder="填写答复以继续"
            disabled={busy}
            value={response}
            onChange={(event) => setResponse(event.target.value)}
            className="min-w-0 flex-1 rounded border px-2 py-1 text-xs"
          /> : <span className="min-w-0 text-xs">{goal.wait.requirementIds?.map(id => goal.requirements.find(item => item.id === id)?.text).join("；")}</span>}
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={busy || (goal.wait.purpose === "clarification" && (!response.trim() || (quotaExhausted && (!expanded || !validQuota))))}
          >
            {goal.wait.purpose === "acceptance" ? "结果满足所列条件" : "提交回答"}
          </Button>
          {goal.wait.purpose === "clarification" && quotaExhausted && !expanded ? (
            <span className="text-xs">自动续跑次数已用完，请先展开详情增加次数。</span>
          ) : null}
        </form>
      ) : null}
    </div>
  )
}
