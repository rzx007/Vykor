import { createRoot, type Root } from "react-dom/client"
import { flushSync } from "react-dom"
import "streamdown/styles.css"
import { AssistantMarkdown } from "../../src/renderer/src/components/desktop/conversation-page/message/markdown/assistant-markdown"
import { AppearanceProvider } from "../../src/renderer/src/components/appearance/appearance-provider"
import { APPEARANCE_STORAGE_KEY } from "../../src/renderer/src/components/appearance/appearance-preferences"

type Scenario = "paragraph" | "rich-paragraph" | "list"
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const host = document.createElement("div")
host.style.cssText = "width:960px;height:480px;overflow:auto;font:16px/1.7 Arial,sans-serif"
document.body.append(host)
let root: Root | undefined
let scenario: Scenario
let source = ""
let streaming = true
let animation = true
let sequence = 0
const openFile = () => {}
const reply = () => host.querySelector<HTMLElement>(".assistant-markdown")!
function require(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}
function render() {
  flushSync(() =>
    root!.render(
      <AppearanceProvider>
        <AssistantMarkdown
          text={source}
          streaming={streaming}
          animateInitialText={false}
          onOpenFile={openFile}
        />
      </AppearanceProvider>
    )
  )
}
async function waitFor(marker: string) {
  const deadline = performance.now() + 15_000
  while (!reply()?.textContent?.trimEnd().endsWith(marker)) {
    require(performance.now() < deadline, "Markdown output stopped updating")
    await frame()
  }
  await frame()
}
const api = {
  async prepare(kind: Scenario, enabled: boolean) {
    if (root) flushSync(() => root!.unmount())
    host.replaceChildren()
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        reducedMotion: "off",
        streamingTextAnimation: enabled,
      })
    )
    root = createRoot(host)
    scenario = kind
    animation = enabled
    streaming = true
    sequence = 0
    source =
      kind === "paragraph"
        ? "超长段落中的连续中文正文。".repeat(8000)
        : kind === "rich-paragraph"
          ? "**中文强调** 与 [链接](https://example.com) 和普通文字。".repeat(800)
          : Array.from(
              { length: 2000 },
              (_, index) =>
                `${index + 1}. **项目${index}** 与 [链接](https://example.com) 和普通文字。`
            ).join("\n")
    render()
    await frame()
    require(!!reply(), "Markdown did not mount")
    // 同样的两次预热不计入测量，排除首次加载及初始大块解析。
    await api.append()
    await api.append()
    await new Promise((resolve) => setTimeout(resolve, 180))
    return { characters: source.length, listItems: scenario === "list" ? 2002 : 0 }
  },
  async append() {
    const marker = `追加编号${++sequence}结束`
    source += scenario === "list" ? `\n${2000 + sequence}. **新增项目** ${marker}` : marker
    const start = performance.now()
    render()
    await waitFor(marker)
    return performance.now() - start
  },
  async measure(updates: number) {
    const longTasks: number[] = []
    const observer = new PerformanceObserver((list) => {
      longTasks.push(...list.getEntries().map((entry) => entry.duration))
    })
    observer.observe({ type: "longtask" })
    const latencies: number[] = []
    let maxAnimatedNodes = 0
    for (let index = 0; index < updates; index++) {
      latencies.push(await api.append())
      const nodes = reply().querySelectorAll<HTMLElement>("[data-sd-animate]")
      maxAnimatedNodes = Math.max(maxAnimatedNodes, nodes.length)
      require(nodes.length <= 512, "unbounded character animation")
      if (nodes.length)
        require(getComputedStyle(nodes[0]).animationName === "sd-fadeIn", "animation CSS missing")
    }
    await new Promise((resolve) => setTimeout(resolve, 180))
    longTasks.push(...observer.takeRecords().map((entry) => entry.duration))
    observer.disconnect()
    require(!reply().querySelector("[data-sd-animate]"), "animation nodes did not retire")
    require(animation
      ? maxAnimatedNodes > 0
      : maxAnimatedNodes === 0, "animation switch did not apply")
    if (scenario === "list")
      require(reply().querySelectorAll("li").length === 2000 + sequence, "list items missing")
    if (scenario !== "paragraph") {
      require(!!reply().querySelector("strong"), "bold markup missing")
      require(!!reply().querySelector("a"), "link markup missing")
    }
    latencies.sort((a, b) => a - b)
    return {
      updates,
      maxAnimatedNodes,
      visibleP50Ms: latencies[Math.floor(latencies.length / 2)],
      visibleMaxMs: Math.max(...latencies),
      longTasks: longTasks.length,
      longestTaskMs: Math.max(0, ...longTasks),
    }
  },
  async finish() {
    const text = reply().textContent
    streaming = false
    render()
    await frame()
    require(reply().textContent === text, "completion changed visible content")
    require(!reply().querySelector("[data-sd-animate]"), "completed animation still mounted")
    return { passed: true }
  },
}
Object.assign(window, { markdownPerformance: api })
