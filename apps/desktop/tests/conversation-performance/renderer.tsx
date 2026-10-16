import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { useLayoutEffect } from "react"
import {
  VirtualTranscript,
  type TranscriptRow,
} from "../../src/renderer/src/components/desktop/conversation-page/transcript/virtual-transcript"
import {
  ConversationScrollerProvider,
  ConversationScrollerViewport,
  ConversationScrollerContent,
  ConversationScrollerButton,
} from "../../src/renderer/src/components/desktop/conversation-page/conversation-scroller"
import { useConversationScroller } from "../../src/renderer/src/components/desktop/conversation-page/conversation-scroll-context"

const style = document.createElement("style")
style.textContent = `[data-slot=message-scroller-viewport]{width:960px;height:480px;overflow-y:auto;overflow-anchor:none}[data-slot=message-scroller-content]{min-height:100%}[data-virtual-transcript]{position:relative;width:100%}[data-transcript-row]{position:absolute;top:0;left:0;width:100%}`
document.head.append(style)
const root = createRoot(document.getElementById("root")!)
let controller: NonNullable<ReturnType<typeof useConversationScroller>>
export function Probe() {
  const state = useConversationScroller()!
  useLayoutEffect(() => {
    controller = state
  }, [state])
  return null
}
let rows: TranscriptRow[] = []
let height = 120
let chat = 0
const viewport = () =>
  document.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')!
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const settle = async () => {
  for (let index = 0; index < 6; index++) await frame()
}
function render() {
  flushSync(() =>
    root.render(
      <ConversationScrollerProvider key={chat}>
        <Probe />
        <ConversationScrollerViewport>
          <ConversationScrollerContent>
            <VirtualTranscript
              rows={rows}
              renderRow={(index) => (
                <div style={{ height: index === rows.length - 1 ? height : 120 }}>
                  {rows[index].id}
                </div>
              )}
            />
          </ConversationScrollerContent>
        </ConversationScrollerViewport>
        <ConversationScrollerButton />
      </ConversationScrollerProvider>
    )
  )
}
function require(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}
const api = {
  async prepare(count: number) {
    chat++
    height = 120
    rows = Array.from({ length: count }, (_, index) => ({
      id: `turn-${index}`,
      messageIds: [`prompt-${index}`],
      estimateSize: 120,
    }))
    render()
    await settle()
    require(controller.getSnapshot().following, "initial follow missing")
  },
  async grow(updates: number) {
    let maxSettledGap = 0
    let maxMounted = 0
    for (let index = 0; index < updates; index++) {
      height += 12
      render()
      await frame()
      await frame()
      maxSettledGap = Math.max(
        maxSettledGap,
        viewport().scrollHeight - viewport().clientHeight - viewport().scrollTop
      )
      maxMounted = Math.max(maxMounted, document.querySelectorAll("[data-transcript-row]").length)
    }
    await settle()
    require(maxSettledGap <= 1, "stream briefly lagged behind measured content")
    require(controller.getSnapshot().following, "stream lost following")
    require(viewport().scrollHeight - viewport().clientHeight - viewport().scrollTop <=
      1, "stream not at bottom")
    require(maxMounted < 25, "unbounded mounted history")
    return { updates, maxSettledGap, maxMounted }
  },
  async regress() {
    require(controller.scrollToMessage("prompt-400"), "history navigation unavailable")
    await settle()
    require(document.querySelector('[data-transcript-row="turn-400"]') !==
      null, "history target not mounted")
    require(controller.getSnapshot().activeMessageId ===
      "prompt-400", "history navigation selection mismatch")
    const position = viewport().scrollTop
    for (let index = 0; index < 10; index++) {
      height += 20
      render()
      await frame()
    }
    await settle()
    require(viewport().scrollTop === position, "stream moved historical reader")
    require(!controller.getSnapshot().following, "history navigation rearmed following")
    controller.scrollToEnd()
    await settle()
    require(controller.getSnapshot().following, "jump latest failed to resume")
    await api.grow(10)
    viewport().dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }))
    const detached = viewport().scrollTop
    height += 100
    render()
    await settle()
    require(viewport().scrollTop === detached, "upward intent lost to growth")
    return { passed: true }
  },
}
Object.assign(window, { transcriptPerformance: api })
