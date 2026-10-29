import { useEffect, useRef, useState } from "react"

import type { DesktopContextUsageSnapshot } from "@shared/context-usage-types"
import { Button } from "@renderer/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover"

import { ContextUsageRing } from "./context-usage-ring"
import { ContextUsageTray } from "./context-usage-tray"

export function ContextUsageControl({
  snapshot,
  onOpen,
}: {
  snapshot: DesktopContextUsageSnapshot | null
  onOpen?: () => void | Promise<boolean | void>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const requestGeneration = useRef(0)

  useEffect(
    () => () => {
      requestGeneration.current++
    },
    []
  )

  const refresh = async (): Promise<void> => {
    const generation = ++requestGeneration.current
    setFailed(false)
    if (!onOpen) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const result = await onOpen()
      if (generation === requestGeneration.current) setFailed(result === false)
    } catch {
      if (generation === requestGeneration.current) setFailed(true)
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) void refresh()
        else {
          requestGeneration.current++
          setLoading(false)
        }
      }}
    >
      <PopoverTrigger render={<ContextUsageRing snapshot={snapshot} className="shrink-0" />} />
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-auto gap-0 rounded-xl p-2 shadow-lg ring-1 ring-black/10"
      >
        {snapshot ? (
          <ContextUsageTray snapshot={snapshot} />
        ) : !failed && !loading ? (
          <div className="w-64 px-2 py-3 text-xs text-muted-foreground">暂无上下文用量。</div>
        ) : null}
        {loading ? (
          <p role="status" className="w-64 px-2 py-3 text-xs text-muted-foreground">
            {snapshot ? "正在更新上下文用量…" : "正在加载上下文…"}
          </p>
        ) : null}
        {failed ? (
          <div className="flex w-64 items-center gap-2 px-2 py-3">
            <p role="alert" className="flex-1 text-xs text-muted-foreground">
              {snapshot ? "上下文用量更新失败，显示上次结果。" : "上下文用量读取失败，请重试。"}
            </p>
            {onOpen ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
                重试
              </Button>
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
