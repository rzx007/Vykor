import { toast } from "@renderer/lib/toast"
import { SettingsGroup, SettingsRow } from "./settings-group"
import { useEffect, useRef, useState } from "react"
import { Button } from "@renderer/components/ui/button"
import { Input } from "@renderer/components/ui/input"
import type {
  MaintenanceSettingsAPI,
  UsageFilter,
  UsagePrice,
  UsageReport,
} from "@shared/maintenance-settings-types"
import { errorMessage } from "./settings-error-message"

export function maintenanceApi(): MaintenanceSettingsAPI {
  const api = (window.desktop as unknown as { maintenance?: MaintenanceSettingsAPI }).maintenance
  if (!api) throw new Error("当前应用未接入维护服务")
  return api
}
export function UsageSettings() {
  const [report, setReport] = useState<UsageReport | null>(null)
  const [filter, setFilter] = useState<UsageFilter>({})
  const [range, setRange] = useState("7")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const sequence = useRef(0)
  const [price, setPrice] = useState<Omit<UsagePrice, "adoptedAt">>({
    provider: "",
    model: "",
    currency: "USD",
    source: "",
    inputPerMillion: 0,
    outputPerMillion: 0,
    cacheReadPerMillion: 0,
    cacheCreationPerMillion: 0,
    subscription: false,
    inputIncludesCache: true,
  })
  const [tokenBudget, setTokenBudget] = useState("")
  const [amountBudget, setAmountBudget] = useState("")
  const [budgetCurrency, setBudgetCurrency] = useState("USD")
  const budgetInitialized = useRef(false)
  const [budgetEditing, setBudgetEditing] = useState(false)
  function activeFilter(): UsageFilter {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    if (range !== "custom") start.setDate(start.getDate() - Number(range) + 1)
    const end = range === "custom" && to ? new Date(`${to}T00:00:00`) : new Date()
    if (range === "custom" && to) end.setDate(end.getDate() + 1)
    return {
      ...filter,
      from:
        range === "custom"
          ? from
            ? new Date(`${from}T00:00:00`).getTime()
            : undefined
          : start.getTime(),
      to: range === "custom" && !to ? undefined : end.getTime(),
    }
  }
  async function load() {
    const current = ++sequence.current
    setBusy(true)
    try {
      const next = await maintenanceApi().usage(activeFilter())
      if (current === sequence.current) {
        setReport(next)
        setError("")
        if (!budgetInitialized.current) {
          budgetInitialized.current = true
          setTokenBudget(next.settings.budget.tokens?.toString() ?? "")
          setAmountBudget(next.settings.budget.amount?.toString() ?? "")
          setBudgetCurrency(next.settings.budget.currency)
        }
      }
    } catch (error) {
      if (current === sequence.current) setError(errorMessage(error))
    } finally {
      if (current === sequence.current) setBusy(false)
    }
  }
  useEffect(() => {
    void load()
    const timer = setInterval(() => {
      void load()
    }, 30_000)
    return () => {
      sequence.current++
      clearInterval(timer)
    }
  }, [filter.project, filter.provider, filter.model, range, from, to])
  async function act(work: () => Promise<unknown>, message: string) {
    setBusy(true)
    try {
      const result = await work()
      if (typeof result === "string") toast.success("导出完成", result)
      else if (message) {
        if (result === null) toast.info(message)
        else toast.success(message)
      }
      setError("")
      await load()
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  const exceeded =
    report?.settings.budget.enabled &&
    ((report.settings.budget.tokens !== null &&
      report.totals.input + report.totals.output >= report.settings.budget.tokens) ||
      (report.settings.budget.amount !== null &&
        (report.totals.costs[report.settings.budget.currency] ?? 0) >=
          report.settings.budget.amount))
  return (
    <div className="flex flex-col gap-8">
      <section id="usage-filters" className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">请求用量</h2>
        <p className="text-xs text-muted-foreground">
          按本地时区统计，每 30 秒刷新；未知用量不计为零。
        </p>
        <div className="settings-filter-grid">
          <label className="flex min-w-0 flex-col gap-2 text-sm">
            时间
            <select
              aria-label="时间范围"
              className="h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm"
              value={range}
              onChange={(event) => setRange(event.target.value)}
            >
              <option value="1">今天</option>
              <option value="7">最近 7 天</option>
              <option value="30">最近 30 天</option>
              <option value="custom">自定义</option>
            </select>
          </label>
          {range === "custom" ? (
            <>
              <label className="flex min-w-0 flex-col gap-2 text-sm">
                开始
                <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
              </label>
              <label className="flex min-w-0 flex-col gap-2 text-sm">
                结束（含当天）
                <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
              </label>
            </>
          ) : null}
          {(["project", "provider", "model"] as const).map((key) => (
            <label key={key} className="text-xs">
              {{ project: "项目", provider: "供应商", model: "模型" }[key]}
              <select
                className="h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm"
                value={filter[key] ?? ""}
                onChange={(event) =>
                  setFilter((previous) => ({ ...previous, [key]: event.target.value }))
                }
              >
                <option value="">全部</option>
                {(
                  report?.options[
                    key === "project" ? "projects" : key === "provider" ? "providers" : "models"
                  ] ?? []
                ).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void load()}>
            刷新
          </Button>
        </div>
        {busy && !report ? (
          <p role="status" className="text-sm">
            正在读取请求记录…
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error} {report ? "仍显示上次读取结果。" : ""}
          </p>
        ) : null}
      </section>
      {report ? (
        <>
          <section id="usage-summary" className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {[
                ["输入 Token", report.totals.input],
                ["输出 Token", report.totals.output],
                ["缓存读取", report.totals.cacheRead],
                ["缓存创建", report.totals.cacheCreation],
                ["请求记录", report.totals.requests],
                ["未知 / 部分", `${report.totals.unknown} / ${report.totals.partial}`],
              ].map(([name, value]) => (
                <div key={name}>
                  <p className="text-xs text-muted-foreground">{name}</p>
                  <p className="text-lg tabular-nums">{value}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              仅统计已知用量。更新于 {new Date(report.scannedAt).toLocaleString()}。
            </p>
            {report.warnings.map((warning) => (
              <p key={warning} className="text-xs text-muted-foreground">
                {warning}
              </p>
            ))}
            <p className="text-sm">
              {Object.keys(report.totals.costs).length
                ? Object.entries(report.totals.costs)
                    .map(([currency, amount]) => `估算 ${currency} ${amount.toFixed(6)}`)
                    .join("；")
                : "未提供费用"}
              。费用为估算，不代表实际扣款。
            </p>
            {exceeded ? (
              <p role="alert" className="text-sm text-destructive">
                已知用量达到提醒阈值，不会停止任务。
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act(() => maintenanceApi().exportUsage(activeFilter(), "csv"), "导出已取消")
                }
              >
                导出 CSV
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act(() => maintenanceApi().exportUsage(activeFilter(), "json"), "导出已取消")
                }
              >
                导出 JSON
              </Button>
            </div>
          </section>
          <section id="usage-details" className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold">请求明细</h2>
            {!report.requests.length ? (
              <p className="text-sm text-muted-foreground">当前范围没有请求记录。</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr>
                      {[
                        "时间 / 任务",
                        "供应商 / 模型",
                        "输入 / 输出",
                        "缓存读 / 写",
                        "完整性",
                        "费用依据",
                      ].map((label) => (
                        <th key={label} className="p-2 font-medium">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.requests.slice(0, 200).map((row) => (
                      <tr key={row.id} className="border-t">
                        <td className="p-2">
                          {new Date(row.time).toLocaleString()}
                          <br />
                          {row.runId}
                        </td>
                        <td className="p-2">
                          {row.provider}
                          <br />
                          {row.model}
                        </td>
                        <td className="p-2">
                          {row.inputTokens ?? "未知"} / {row.outputTokens ?? "未知"}
                        </td>
                        <td className="p-2">
                          {row.cacheReadTokens ?? "未知"} / {row.cacheCreationTokens ?? "未知"}
                        </td>
                        <td className="p-2">
                          {{ complete: "已知", partial: "部分", unknown: "未知" }[row.completeness]}
                        </td>
                        <td className="p-2">
                          {row.cost
                            ? `${row.cost.currency} ${row.cost.amount.toFixed(6)}（估算；${row.cost.source}）`
                            : row.subscription
                              ? "费用由订阅承担"
                              : "未提供费用"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {report.requests.length > 200 ? (
                  <p className="text-xs text-muted-foreground">
                    显示最近 200 条，导出包含全部筛选结果。
                  </p>
                ) : null}
              </div>
            )}
          </section>
          <SettingsGroup title="模型估算价格" id="usage-prices">
            <p className="text-xs text-muted-foreground">
              每百万 Token 单价，仅用于新请求估算；历史记录不变。
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {(["provider", "model", "currency", "source"] as const).map((key) => (
                <label key={key} className="text-xs">
                  {
                    {
                      provider: "供应商",
                      model: "模型",
                      currency: "币种",
                      source: "来源（价格表或说明）",
                    }[key]
                  }
                  <Input
                    placeholder={
                      {
                        provider: "例如 openai",
                        model: "模型 ID",
                        currency: "例如 USD",
                        source: "价格表地址或说明",
                      }[key]
                    }
                    value={price[key]}
                    onChange={(event) =>
                      setPrice((previous) => ({ ...previous, [key]: event.target.value }))
                    }
                  />
                </label>
              ))}
              {(
                [
                  "inputPerMillion",
                  "outputPerMillion",
                  "cacheReadPerMillion",
                  "cacheCreationPerMillion",
                ] as const
              ).map((key) => (
                <label key={key} className="text-xs">
                  {
                    {
                      inputPerMillion: "输入价格",
                      outputPerMillion: "输出价格",
                      cacheReadPerMillion: "缓存读取价格",
                      cacheCreationPerMillion: "缓存创建价格",
                    }[key]
                  }
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    value={price[key]}
                    onChange={(event) =>
                      setPrice((previous) => ({ ...previous, [key]: Number(event.target.value) }))
                    }
                  />
                </label>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={price.subscription}
                onChange={(event) =>
                  setPrice((previous) => ({ ...previous, subscription: event.target.checked }))
                }
              />
              订阅承担费用，不计算 API 费用
            </label>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void act(() => maintenanceApi().price(price), "价格已保存，新请求生效")
              }
            >
              保存价格
            </Button>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={price.inputIncludesCache !== false}
                onChange={(event) =>
                  setPrice((previous) => ({
                    ...previous,
                    inputIncludesCache: event.target.checked,
                  }))
                }
              />
              输入 Token 含缓存（缓存单独计价）
            </label>
            <details>
              <summary className="text-xs">价格历史（{report.settings.prices.length}）</summary>
              {report.settings.prices.map((item, index) => (
                <p key={index} className="py-1 text-xs text-muted-foreground">
                  {item.provider} / {item.model} · {item.currency} · 输入 {item.inputPerMillion} /
                  输出 {item.outputPerMillion} / 缓存读 {item.cacheReadPerMillion} / 写{" "}
                  {item.cacheCreationPerMillion} · {item.source} ·{" "}
                  {new Date(item.adoptedAt).toLocaleString()}
                  {item.subscription ? " · 订阅承担" : ""}
                </p>
              ))}
            </details>
          </SettingsGroup>
          <SettingsGroup title="预算提醒" id="usage-budget" separated>
            <p className="py-3 text-xs text-muted-foreground">
              {report.settings.budget.enabled
                ? "按本月已知用量提醒，不停止任务。"
                : "已关闭。启用后按本月用量提醒，不停止任务。"}
            </p>
            {report.settings.budget.enabled || budgetEditing ? (
              <>
                <SettingsRow
                  title="提醒币种"
                  labelFor="usage-budget-currency"
                  control={
                    <Input
                      id="usage-budget-currency"
                      className="w-28"
                      placeholder="例如 USD"
                      value={budgetCurrency}
                      disabled={busy}
                      onChange={(event) => setBudgetCurrency(event.target.value.toUpperCase())}
                      maxLength={3}
                    />
                  }
                />
                <SettingsRow
                  title="Token 阈值"
                  labelFor="usage-token-budget"
                  control={
                    <Input
                      id="usage-token-budget"
                      className="w-36"
                      placeholder="留空不提醒"
                      type="number"
                      min="1"
                      value={tokenBudget}
                      disabled={busy}
                      onChange={(event) => setTokenBudget(event.target.value)}
                    />
                  }
                />
                <SettingsRow
                  title={`估算费用阈值（${budgetCurrency}）`}
                  labelFor="usage-amount-budget"
                  control={
                    <Input
                      id="usage-amount-budget"
                      className="w-36"
                      placeholder="留空不提醒"
                      type="number"
                      min="0"
                      step="any"
                      value={amountBudget}
                      disabled={busy}
                      onChange={(event) => setAmountBudget(event.target.value)}
                    />
                  }
                />
                <div className="flex justify-end gap-2 py-3">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await maintenanceApi().budget({
                          enabled: true,
                          tokens: tokenBudget ? Number(tokenBudget) : null,
                          amount: amountBudget ? Number(amountBudget) : null,
                          currency: budgetCurrency,
                          expected: report.settings.budget,
                        })
                        setBudgetEditing(false)
                      }, "预算提醒已保存")
                    }
                  >
                    启用并保存
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        async () => {
                          if (report.settings.budget.enabled)
                            await maintenanceApi().budget({
                              ...report.settings.budget,
                              enabled: false,
                              expected: report.settings.budget,
                            })
                          setBudgetEditing(false)
                        },
                        report.settings.budget.enabled ? "预算提醒已关闭" : ""
                      )
                    }
                  >
                    {report.settings.budget.enabled ? "关闭提醒" : "取消设置"}
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex justify-end py-3">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setBudgetEditing(true)}
                >
                  设置并启用
                </Button>
              </div>
            )}
          </SettingsGroup>
        </>
      ) : null}
    </div>
  )
}
