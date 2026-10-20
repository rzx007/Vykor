import { LockKeyhole, Pencil, Puzzle, Send, Share2 } from "lucide-react"

import { Avatar, AvatarFallback } from "@renderer/components/ui/avatar"
import { Badge } from "@renderer/components/ui/badge"
import { cn } from "@renderer/lib/utils"

const summary = [
  { value: "86.3 亿", label: "累计 Token 数" },
  { value: "14.4 亿", label: "峰值 Token 数" },
  { value: "2 小时 6 分", label: "最长任务用时" },
  { value: "9 天", label: "当前连续天数" },
  { value: "9 天", label: "最长连续天数" },
]

const insights = [
  { label: "快速模式", value: "75%" },
  { label: "最常用的推理强度", value: "中 · 35%" },
  { label: "已探索技能数", value: "75" },
  { label: "使用的技能总数", value: "700" },
  { label: "聊天天数", value: "879" },
]

const plugins = [
  { name: "@ponytail", uses: "104 次运行" },
  { name: "$verification-before-completion", uses: "57 次运行" },
  { name: "$test-driven-development", uses: "51 次运行" },
  { name: "$openai-docs", uses: "45 次运行" },
  { name: "$systematic-debugging", uses: "33 次运行" },
]

const months = [
  "10月",
  "11月",
  "12月",
  "1月",
  "2月",
  "3月",
  "4月",
  "5月",
  "6月",
  "7月",
  "8月",
  "9月",
]

// Static demonstration data; replace this array when profile activity has a real source.
const activity = Array.from({ length: 53 * 7 }, (_, index) => {
  const week = Math.floor(index / 7)
  if (week < 49) return 0
  return [0, 1, 2, 1, 3, 0, 2, 1, 4, 2, 3, 1, 0, 2, 4, 3, 2, 1, 2, 0, 3, 1, 2, 4, 0, 1, 3, 2][
    index - 49 * 7
  ]
})

const actionLabels = [
  { icon: Send, label: "邀请好友" },
  { icon: Share2, label: "分享" },
  { icon: LockKeyhole, label: "私有" },
  { icon: Pencil, label: "编辑" },
]

function ActivityHeatmap(): React.JSX.Element {
  return (
    <div
      className="min-w-0 overflow-x-auto"
      role="img"
      aria-label="最近一年的 Token 活动示例，主要集中在末尾几周"
    >
      <div className="min-w-[640px]">
        <div
          aria-hidden="true"
          className="grid grid-flow-col grid-rows-7 gap-1"
          style={{ gridTemplateColumns: "repeat(53, minmax(0, 1fr))" }}
        >
          {activity.map((level, index) => (
            <span
              key={index}
              className="profile-activity-cell aspect-square rounded-[3px]"
              data-level={level}
            />
          ))}
        </div>
        <div className="mt-2 grid grid-cols-12 text-[11px] text-muted-foreground">
          {months.map((month) => (
            <span key={month}>{month}</span>
          ))}
        </div>
      </div>
    </div>
  )
}

export function ProfileSettings(): React.JSX.Element {
  return (
    <div className="min-h-full bg-conversation px-6 pt-6 pb-20 sm:px-10 lg:px-16">
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <h1 className="font-heading text-xl font-semibold tracking-tight">个人资料</h1>
        <div
          className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground"
          aria-label="资料操作预览"
        >
          {actionLabels.map(({ icon: Icon, label }) => (
            <span key={label} className="inline-flex items-center gap-1.5" title="静态展示">
              <Icon aria-hidden="true" className="size-3.5" strokeWidth={1.7} />
              {label}
            </span>
          ))}
        </div>
      </header>

      <div className="mx-auto mt-16 flex w-full max-w-[770px] flex-col gap-11">
        <section className="flex flex-col items-center text-center" aria-label="资料概览">
          <Avatar className="size-21">
            <AvatarFallback className="bg-foreground text-3xl font-semibold text-background">
              V
            </AvatarFallback>
          </Avatar>
          <h2 className="mt-5 text-2xl font-semibold tracking-tight">Vykor 用户</h2>
          <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
            <span>vykor-user</span>
            <span aria-hidden="true">·</span>
            <Badge variant="outline" className="font-normal text-muted-foreground">
              示例资料
            </Badge>
          </div>
        </section>

        <section
          aria-label="使用概览"
          className="grid grid-cols-2 rounded-xl border border-border/70 px-3 py-3 sm:grid-cols-5"
        >
          {summary.map((item, index) => (
            <div
              key={item.label}
              className={cn(
                "min-w-0 px-3 py-2 text-center sm:py-0",
                index > 0 && "sm:border-l sm:border-border/70"
              )}
            >
              <p className="text-sm font-medium text-foreground tabular-nums">{item.value}</p>
              <p className="mt-1 text-xs text-muted-foreground">{item.label}</p>
            </div>
          ))}
        </section>

        <section aria-label="Token 活动" className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-sm font-semibold">Token 活动</h2>
            <div
              className="flex items-center gap-3 text-xs text-muted-foreground"
              aria-label="活动视图预览"
            >
              <span className="font-medium text-foreground">每日</span>
              <span>每周</span>
              <span>累计</span>
            </div>
          </div>
          <ActivityHeatmap />
        </section>

        <div className="grid gap-10 sm:grid-cols-2 sm:gap-12">
          <section aria-label="活动洞察">
            <h2 className="mb-4 text-sm font-semibold">活动洞察</h2>
            <dl className="flex flex-col gap-3">
              {insights.map((item) => (
                <div key={item.label} className="flex items-baseline justify-between gap-4 text-sm">
                  <dt className="text-muted-foreground">{item.label}</dt>
                  <dd className="shrink-0 text-foreground tabular-nums">{item.value}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section aria-label="最常用的插件">
            <h2 className="mb-4 text-sm font-semibold">最常用的插件</h2>
            <ul className="flex flex-col gap-3">
              {plugins.map((plugin) => (
                <li key={plugin.name} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="flex min-w-0 items-center gap-2 text-foreground">
                    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                      <Puzzle className="size-3" aria-hidden="true" />
                    </span>
                    <span className="truncate">{plugin.name}</span>
                  </span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">{plugin.uses}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  )
}
