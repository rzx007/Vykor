import { useEffect, useState } from "react"

export type InteractiveUiPreference = "generation" | "rich"

export function useInteractiveUiPreference(preference: InteractiveUiPreference = "generation") {
  const [value, setValue] = useState<{
    preference: InteractiveUiPreference
    enabled: boolean | null
    error: string
  }>()
  useEffect(() => {
    const settings = window.desktop?.settings
    const isRich = preference === "rich"
    const getEnabled = isRich ? settings?.getRichUiEnabled : settings?.getInteractiveUiEnabled
    const subscribe = isRich
      ? settings?.onRichUiEnabledChanged
      : settings?.onInteractiveUiEnabledChanged
    if (!getEnabled || !subscribe) return

    let useInitialValue = true
    const unsubscribe = subscribe((enabled) => {
      useInitialValue = false
      setValue({ preference, enabled, error: "" })
    })
    void getEnabled().then(
      (enabled) => {
        if (useInitialValue) setValue({ preference, enabled, error: "" })
      },
      () => {
        if (useInitialValue)
          setValue({
            preference,
            enabled: null,
            error: isRich ? "无法读取聊天富内容的设置。" : "无法读取生成交互界面的设置。",
          })
      }
    )
    return () => {
      useInitialValue = false
      unsubscribe()
    }
  }, [preference])
  const current = value?.preference === preference ? value : undefined
  return { enabled: current?.enabled ?? null, error: current?.error ?? "" }
}
