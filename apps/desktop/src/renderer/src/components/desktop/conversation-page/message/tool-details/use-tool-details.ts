import { useEffect, useState } from "react"
import type { DesktopSessionPart } from "@shared/session-types"

function detailIdentity(part?: DesktopSessionPart): string {
  if (!part) return ""
  // Millisecond timestamps are not revisions. Include the observed settlement and body availability.
  return JSON.stringify([
    part.sessionId,
    part.messageId,
    part.id,
    part.updatedAt,
    part.status,
    part.isError,
    part.input !== undefined,
    part.output !== undefined,
    part.bodyView?.input,
    part.bodyView?.output,
    part.metadata.executionState,
    part.metadata.failureKind,
  ])
}

function withBodies(current: DesktopSessionPart, full?: DesktopSessionPart): DesktopSessionPart {
  if (!full) return current
  return {
    ...current,
    input: full.input,
    output: full.output,
    bodyView: {
      input: full.input === undefined ? "unavailable" : "full",
      output: full.output === undefined ? "unavailable" : "full",
    },
  }
}

/** Detail belongs only to the currently expanded source, never the session summary store. */
export function useToolDetails(
  call: DesktopSessionPart,
  result?: DesktopSessionPart,
  enabled = false
) {
  const key = `${detailIdentity(call)}:${detailIdentity(result)}`
  const needsDetail = [call, result].some(
    (part) => part?.bodyView?.input === "preview" || part?.bodyView?.output === "preview"
  )
  const [loaded, setLoaded] = useState<{
    key: string
    call?: DesktopSessionPart
    result?: DesktopSessionPart
    error?: string
  }>()
  useEffect(() => {
    if (!enabled || !needsDetail) {
      setLoaded(undefined)
      return
    }
    let current = true
    const read = async (part: DesktopSessionPart): Promise<DesktopSessionPart> => {
      if (part.bodyView?.input !== "preview" && part.bodyView?.output !== "preview") return part
      const detail = await window.desktop.sessions.getMessagePart({
        sessionId: part.sessionId,
        messageId: part.messageId,
        partId: part.id,
      })
      if (
        detail.sessionId !== part.sessionId ||
        detail.messageId !== part.messageId ||
        detail.id !== part.id ||
        detail.updatedAt < part.updatedAt
      )
        throw new Error("内容已变化")
      return detail
    }
    void Promise.all([read(call), result ? read(result) : Promise.resolve(undefined)]).then(
      ([fullCall, fullResult]) => {
        if (current) setLoaded({ key, call: fullCall, result: fullResult })
      },
      () => {
        if (current) setLoaded({ key, error: "完整详情不可用；当前仅显示预览。" })
      }
    )
    return () => {
      current = false
    }
    // Only identity, settlement and bounded availability fields invalidate this read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, needsDetail])
  const detail = enabled && loaded?.key === key ? loaded : undefined
  return {
    call: withBodies(call, detail?.call),
    result: result ? withBodies(result, detail?.result) : undefined,
    preview: needsDetail && !detail?.call,
    error: detail?.error,
  }
}
