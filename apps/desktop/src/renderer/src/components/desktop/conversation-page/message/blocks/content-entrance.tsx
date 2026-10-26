import { useEffect, useState, type ReactNode } from "react"

export function ContentEntrance({ animate, children }: { animate: boolean; children: ReactNode }) {
  // 只在挂载时决定：本地消息转成正式记录，仍是同一次入场。
  const [entering, setEntering] = useState(animate)

  useEffect(() => {
    if (!entering) return
    // 关闭动效或隐藏窗口时可能没有结束事件，仍需清理入场标记。
    const timer = window.setTimeout(() => setEntering(false), 250)
    return () => window.clearTimeout(timer)
  }, [entering])

  return (
    <div
      data-content-enter={entering ? "" : undefined}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setEntering(false)
      }}
    >
      {children}
    </div>
  )
}
