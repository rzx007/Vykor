import { useEffect, useState } from "react"

export function useInteractiveUiPreference() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [error, setError] = useState("")
  useEffect(() => {
    const settings = window.desktop?.settings
    if (!settings?.getInteractiveUiEnabled) return
    let useInitialValue = true
    const unsubscribe = settings.onInteractiveUiEnabledChanged((value) => {
      useInitialValue = false
      setEnabled(value)
      setError("")
    })
    void settings.getInteractiveUiEnabled().then(
      (value) => { if (useInitialValue) setEnabled(value) },
      () => { if (useInitialValue) setError("无法读取生成交互界面的设置。") },
    )
    return () => {
      useInitialValue = false
      unsubscribe()
    }
  }, [])
  return { enabled, error }
}
