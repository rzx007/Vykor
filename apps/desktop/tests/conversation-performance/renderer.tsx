import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { useLayoutEffect } from "react"
import "./markdown"
import {
  VirtualTranscript,
  type TranscriptRow,
} from "../../src/renderer/src/components/desktop/conversation-page/transcript/virtual-transcript"
import {
  ConversationScrollerProvider,
  ConversationScrollerViewport,
  ConversationScrollerContent,
  ConversationScrollerButton,
} from "../../src/renderer/src/components/desktop/conversation-page/transcript/conversation-scroller"
import { useConversationScroller } from "../../src/renderer/src/components/desktop/conversation-page/transcript/conversation-scroll-context"
import { AssistantMarkdown } from "../../src/renderer/src/components/desktop/conversation-page/message/markdown/assistant-markdown"
import { AppearanceProvider } from "../../src/renderer/src/components/appearance/appearance-provider"

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
let resizedHistoryRow: number | null = null
let chat = 0
let markdown: string | null = null
let streaming = true
let freshFileHandler = true
const openFile = () => {}
const viewport = () =>
  document.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')!
const bottomGap = () => viewport().scrollHeight - viewport().clientHeight - viewport().scrollTop
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
              renderRow={(index) =>
                index === rows.length - 1 && markdown !== null ? (
                  <AppearanceProvider>
                    <AssistantMarkdown
                      text={markdown}
                      streaming={streaming}
                      animateInitialText={false}
                      onOpenFile={freshFileHandler ? () => {} : openFile}
                    />
                  </AppearanceProvider>
                ) : (
                  <div
                    style={{
                      height:
                        index === resizedHistoryRow
                          ? 320
                          : index === rows.length - 1
                            ? height
                            : 120,
                    }}
                  >
                    {rows[index].id}
                  </div>
                )
              }
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
async function waitForBottom(timeoutMs: number) {
  const start = performance.now()
  let stableFrames = 0
  while (performance.now() - start < timeoutMs) {
    await frame()
    stableFrames = bottomGap() <= 1 ? stableFrames + 1 : 0
    if (stableFrames === 2) break
  }
  const elapsedMs = performance.now() - start
  require(stableFrames === 2, `follow did not settle within ${timeoutMs}ms: gap=${bottomGap()}`)
  return elapsedMs
}
const api = {
  async prepare(count: number) {
    document.documentElement.dataset.reducedMotion = "false"
    chat++
    markdown = null
    height = 120
    resizedHistoryRow = null
    rows = Array.from({ length: count }, (_, index) => ({
      id: `turn-${index}`,
      messageIds: [`prompt-${index}`],
      estimateSize: 120,
    }))
    render()
    await settle()
    require(controller.getSnapshot().following, "initial follow missing")
    require(bottomGap() <= 1, "initial transcript did not open at bottom")
  },
  async historyResize(count: number) {
    await api.prepare(count)
    require(controller.scrollToMessage("prompt-400"), "history navigation unavailable")
    await settle()
    viewport().dispatchEvent(new WheelEvent("wheel", { deltaY: -30, bubbles: true }))
    viewport().scrollTop -= 30
    await frame()
    await frame()
    const before = viewport().scrollTop
    require(!!document.querySelector(
      '[data-transcript-row="turn-397"]'
    ), "overscan row unavailable")
    resizedHistoryRow = 397
    render()
    await frame()
    await frame()
    return {
      correctionPx: viewport().scrollTop - before,
      following: controller.getSnapshot().following,
    }
  },
  async grow(updates: number) {
    const initialTop = viewport().scrollTop
    const tail = document.querySelector<HTMLElement>(
      `[data-transcript-row="${rows[rows.length - 1].id}"]`
    )!
    const initialHeight = tail.getBoundingClientRect().height
    let measuredWithoutJump = false
    let measuredGrowth = false
    let maxGap = 0
    let maxMounted = 0
    let progressiveFrames = 0
    let previousTop = initialTop
    let lastUpdateTime = performance.now()
    // 此观察器晚于虚拟列表注册，在同次测高交付中检查是否已被直接拉到底。
    const observer = new ResizeObserver((entries) => {
      if (!entries.some((entry) => entry.contentRect.height > initialHeight)) return
      maxGap = Math.max(maxGap, bottomGap())
      if (!measuredGrowth) {
        measuredGrowth = true
        measuredWithoutJump = Math.abs(viewport().scrollTop - initialTop) <= 1 && bottomGap() > 1
      }
    })
    observer.observe(tail)
    const sample = () => {
      const top = viewport().scrollTop
      const gap = bottomGap()
      require(top >= previousTop - 1, "stream follow moved backward")
      if (top > previousTop + 0.01 && gap > 1) progressiveFrames++
      previousTop = top
      maxGap = Math.max(maxGap, gap)
      maxMounted = Math.max(maxMounted, document.querySelectorAll("[data-transcript-row]").length)
    }
    try {
      for (let index = 0; index < updates; index++) {
        height += 12
        lastUpdateTime = performance.now()
        render()
        await frame()
        sample()
        await frame()
        sample()
      }
    } finally {
      observer.disconnect()
    }
    require(measuredGrowth && measuredWithoutJump, "measured stream growth jumped immediately")
    require(progressiveFrames >= 2, "stream growth did not advance across animation frames")
    require(maxGap <= 32, `stream lag exceeded 32px: ${maxGap}`)
    await waitForBottom(Math.max(0, 160 - (performance.now() - lastUpdateTime)))
    const settleMs = performance.now() - lastUpdateTime
    const stoppedTop = viewport().scrollTop
    await settle()
    require(Math.abs(viewport().scrollTop - stoppedTop) <= 1, "stream moved after settling")
    require(controller.getSnapshot().following, "stream lost following")
    require(bottomGap() <= 1, "stream not at bottom")
    require(maxMounted < 25, "unbounded mounted history")
    return { updates, maxGap, progressiveFrames, measuredWithoutJump, settleMs, maxMounted }
  },
  async streamingCode(count: number, large = false) {
    await api.prepare(count)
    freshFileHandler = !large
    const first = "const first = 1;"
    markdown = `\`\`\`ts\n${first}\n\`\`\``
    streaming = true
    render()
    const deadline = performance.now() + 10_000
    while (!document.querySelector('pre code span[style*="color"]') && performance.now() < deadline)
      await frame()
    const firstPre = document.querySelector("pre")!
    require(!!firstPre?.querySelector('span[style*="color"]'), "initial code was not colored")
    let updates = 0
    for (let block = 1; block <= 3; block++) {
      markdown += "\n\n```ts\n"
      let code = ""
      for (let line = 0; line < 35; line++) {
        const chunk =
          `const block${block}line${line} = "中文😀 streaming code should stay visible while growing";\n`.repeat(
            large ? 10 : 1
          )
        code += chunk
        markdown += chunk
        render()
        await frame()
        await frame()
        updates++
        require(document.querySelector("pre") === firstPre, "earlier code block remounted")
        require(!!firstPre.querySelector('span[style*="color"]'), "earlier code lost its colors")
        const active = document.querySelectorAll("pre code")[block]
        require(active?.textContent === code.trimEnd(), "live source waited for highlighting")
      }
      markdown += "```"
      render()
      await settle()
    }
    require(controller.getSnapshot().following, "code growth lost following")
    require(document.querySelectorAll("pre").length === 4, "missing sequential code blocks")
    await waitForBottom(160)
    const beforeCompletion = viewport().scrollTop
    streaming = false
    render()
    await settle()
    require(bottomGap() <= 1, "completion left reply away from bottom")
    require(Math.abs(viewport().scrollTop - beforeCompletion) <=
      1, "completion jumped settled reply")
    require(document.querySelector("pre") === firstPre, "completion remounted earlier code")
    require(!!firstPre.querySelector('span[style*="color"]'), "completion cleared earlier colors")
    require(document.querySelectorAll("pre").length === 4, "completion lost code blocks")
    return { updates, blocks: 4, passed: true }
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
    const returnButton = () =>
      document.querySelector<HTMLButtonElement>('button[aria-label*="回到最新"]')!
    returnButton().click()
    require(viewport().scrollTop === position, "jump latest moved synchronously")
    await frame()
    await frame()
    require(controller.getSnapshot().following, "jump latest failed to resume")
    require(viewport().scrollTop > position && bottomGap() > 1, "jump latest had no smooth travel")
    const interruptedGap = bottomGap()
    viewport().dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }))
    viewport().scrollTop -= 30
    const detached = viewport().scrollTop
    height += 100
    render()
    await settle()
    require(viewport().scrollTop === detached, "upward intent lost to growth")
    require(!controller.getSnapshot().following, "upward intent did not stop active animation")
    returnButton().click()
    const resumedMs = await waitForBottom(500)
    require(controller.getSnapshot().following, "jump latest failed after interruption")
    await api.grow(10)
    return { passed: true, interruptedGap, resumedMs }
  },
}
Object.assign(window, { transcriptPerformance: api })
