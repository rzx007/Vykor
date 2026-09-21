import { useEffect, useState } from "react"

/** 读取桌面设置里的思考过程开关；页面挂载时取一次，取回前先按关闭渲染以避免闪烁。 */
export function useShowReasoning(): boolean {
  const [showReasoning, setShowReasoning] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.desktop.settings
      .snapshot()
      .then((snapshot) => {
        if (!cancelled) setShowReasoning(snapshot.showReasoning)
      })
      .catch(() => {
        if (!cancelled) setShowReasoning(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return showReasoning
}
