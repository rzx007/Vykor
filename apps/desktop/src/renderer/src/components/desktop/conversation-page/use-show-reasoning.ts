import { useEffect, useState } from "react"

/** 读取桌面设置里的思考过程开关；页面挂载时取一次，默认显示。 */
export function useShowReasoning(): boolean {
  const [showReasoning, setShowReasoning] = useState(true)

  useEffect(() => {
    let cancelled = false
    void window.desktop.settings
      .snapshot()
      .then((snapshot) => {
        if (!cancelled) setShowReasoning(snapshot.showReasoning)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return showReasoning
}
