import { useState } from "react"
import type { UsageSettings } from "@shared/maintenance-settings-types"
import { Button } from "@renderer/components/ui/button"
import { Input } from "@renderer/components/ui/input"
import { formatCount } from "./usage-analytics"
import { Card, CardHeader } from "@renderer/components/motion/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleIndicator,
  CollapsibleTrigger,
} from "@renderer/components/motion/collapsible"
import { UsageHelp } from "./usage-ui"

type Budget = UsageSettings["budget"]
export function UsageTokenBudget({
  budget,
  busy,
  onSave,
}: {
  budget: Budget
  busy: boolean
  onSave: (value: Budget & { expected: Budget }) => Promise<boolean>
}) {
  const [editing, setEditing] = useState(false)
  const [tokens, setTokens] = useState("")
  const [error, setError] = useState("")
  const legacyAmount = budget.enabled && budget.amount !== null
  return (
    <Collapsible id="usage-budget">
      <Card size="compact" className="gap-0 border-border/70 py-0">
        <CardHeader className="flex items-center gap-1 px-1 py-2">
          <CollapsibleTrigger className="min-h-10 flex-1">
            <span>本月 Token 提醒</span>
            <span className="text-xs font-normal text-muted-foreground">
              {legacyAmount
                ? "旧版提醒已启用"
                : budget.enabled && budget.tokens !== null
                  ? `已开启 · ${formatCount(budget.tokens)} Token`
                  : "未开启"}
            </span>
            <CollapsibleIndicator />
          </CollapsibleTrigger>
          <UsageHelp label="本月 Token 提醒说明">
            <p>按本月所有项目的已知 Token 合计提醒，不受上方筛选影响。</p>
            <p>达到阈值时发送系统通知，不会停止任务；通知是否显示取决于通知设置。</p>
          </UsageHelp>
        </CardHeader>
        <CollapsibleContent contentClassName="px-4 pb-4">
          {legacyAmount && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span>旧版金额提醒仍可能发送通知</span>
              <UsageHelp label="旧版提醒说明">
                <p>保存 Token 阈值会替换旧规则，也可直接关闭提醒；只展开设置不会修改规则。</p>
              </UsageHelp>
            </div>
          )}
          {editing ? (
            <form
              className="mt-4 space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                const threshold = Number(tokens)
                if (!Number.isSafeInteger(threshold) || threshold < 1) {
                  setError("请输入大于 0 的整数 Token 阈值")
                  return
                }
                void onSave({
                  ...budget,
                  enabled: true,
                  tokens: threshold,
                  amount: null,
                  expected: budget,
                }).then((saved) => {
                  if (saved) setEditing(false)
                })
              }}
            >
              <label
                htmlFor="usage-token-budget"
                className="flex flex-wrap items-center justify-between gap-3 text-sm"
              >
                Token 阈值
                <Input
                  id="usage-token-budget"
                  className="w-44"
                  type="number"
                  min="1"
                  step="1"
                  value={tokens}
                  disabled={busy}
                  aria-invalid={!!error}
                  aria-describedby={error ? "usage-token-budget-error" : undefined}
                  onChange={(event) => {
                    setTokens(event.target.value)
                    setError("")
                  }}
                />
              </label>
              {error && (
                <p id="usage-token-budget-error" role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  shape="pill"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setEditing(false)}
                >
                  取消设置
                </Button>
                <Button type="submit" shape="pill" size="sm" disabled={busy}>
                  {legacyAmount ? "保存并替换旧提醒" : budget.enabled ? "保存提醒" : "启用并保存"}
                </Button>
              </div>
            </form>
          ) : (
            <div className="mt-3 flex justify-end gap-2">
              {budget.enabled && (
                <Button
                  size="sm"
                  shape="pill"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void onSave({ ...budget, enabled: false, expected: budget })}
                >
                  关闭提醒
                </Button>
              )}
              <Button
                size="sm"
                shape="pill"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setTokens(budget.tokens?.toString() ?? "")
                  setError("")
                  setEditing(true)
                }}
              >
                {legacyAmount ? "改为 Token 提醒" : budget.enabled ? "调整阈值" : "设置并启用"}
              </Button>
            </div>
          )}
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}
