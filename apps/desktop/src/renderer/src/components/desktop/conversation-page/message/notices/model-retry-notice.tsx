import type { SessionModelRetryState } from "@vykor/client"
import { useEffect, useState } from "react"

/**
 * 显示一次有界模型重试的等待过程。`now` 可注入以便测试倒计时。
 * 使用 role="status" 但关闭 aria-live 的逐秒播报，避免刷屏。
 */
export function ModelRetryNotice({
  retry,
  now,
}: {
  retry: SessionModelRetryState
  now?: number
}): React.JSX.Element {
  const [clock, setClock] = useState(Date.now)
  useEffect(() => {
    if (now !== undefined) return
    setClock(Date.now())
    const timer = setInterval(() => setClock(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [now, retry.nextRetryAt])
  const seconds = Math.max(0, Math.ceil((retry.nextRetryAt - (now ?? clock)) / 1000))
  const label =
    seconds > 0
      ? `连接中断，${seconds} 秒后重试（第 ${retry.retryNumber}/${retry.maxRetries} 次）`
      : `正在重新连接（第 ${retry.retryNumber}/${retry.maxRetries} 次）`
  return (
    <div
      role="status"
      aria-live="off"
      className="flex items-center gap-2 text-xs text-ui-muted"
    >
      <span>{label}</span>
    </div>
  )
}
