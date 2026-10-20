// @vitest-environment jsdom
import { act, Profiler } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { VirtualTranscript, type TranscriptRow } from "../virtual-transcript"
import {
  ConversationScrollerProvider,
  ConversationScrollerViewport,
  ConversationScrollerContent,
} from "../conversation-scroller"

const metrics = vi.hoisted(() => ({
  keys: 0,
  notifications: 0,
  measurements: 0,
  measurementMs: 0,
  refreshes: 0,
  commits: 0,
  renderMs: 0,
}))
vi.mock("@tanstack/react-virtual", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-virtual")>()
  const keyFunctions = new WeakMap<
    NonNullable<Parameters<typeof actual.useVirtualizer>[0]["getItemKey"]>,
    NonNullable<Parameters<typeof actual.useVirtualizer>[0]["getItemKey"]>
  >()
  const instrumented = new WeakSet<object>()
  return {
    ...actual,
    useVirtualizer(options: Parameters<typeof actual.useVirtualizer>[0]) {
      const getKey = options.getItemKey!
      let measuredKey = keyFunctions.get(getKey)
      if (!measuredKey) {
        measuredKey = (index) => {
          metrics.keys++
          return getKey(index)
        }
        keyFunctions.set(getKey, measuredKey)
      }
      const instance = actual.useVirtualizer({
        ...options,
        getItemKey: measuredKey,
        onChange: (value, sync) => {
          metrics.notifications++
          options.onChange?.(value, sync)
        },
      })
      if (!instrumented.has(instance)) {
        instrumented.add(instance)
        // 仅测量夹具观察内部缓存，产品代码不依赖私有方法。
        const getMeasurements = Reflect.get(
          instance,
          "getMeasurements"
        ) as () => typeof instance.measurementsCache
        let previous: ReturnType<typeof getMeasurements>
        Reflect.set(instance, "getMeasurements", () => {
          metrics.measurements++
          const start = performance.now()
          const result = getMeasurements()
          metrics.measurementMs += performance.now() - start
          if (result !== previous) {
            metrics.refreshes++
            previous = result
          }
          return result
        })
      }
      return instance
    },
  }
})

const observers = new Set<Observer>()
const heights = new Map<string, number>()
class Observer {
  private targets = new Map<Element, string>()
  constructor(private callback: ResizeObserverCallback) {
    observers.add(this)
  }
  observe(target: Element) {
    this.targets.set(target, "")
  }
  unobserve(target: Element) {
    this.targets.delete(target)
  }
  disconnect() {
    this.targets.clear()
    observers.delete(this)
  }
  flush() {
    const entries: ResizeObserverEntry[] = []
    for (const [target, previous] of this.targets) {
      if (!target.isConnected) continue
      const element = target as HTMLElement
      const height = element.dataset.transcriptRow
        ? (heights.get(element.dataset.transcriptRow) ?? 120)
        : 480
      const size = `960:${height}`
      if (size === previous) continue
      this.targets.set(target, size)
      entries.push({
        target,
        borderBoxSize: [{ inlineSize: 960, blockSize: height }],
        contentBoxSize: [{ inlineSize: 960, blockSize: height }],
        devicePixelContentBoxSize: [{ inlineSize: 960, blockSize: height }],
        contentRect: new DOMRectReadOnly(0, 0, 960, height),
      })
    }
    if (entries.length) this.callback(entries, this as unknown as ResizeObserver)
  }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  observers.clear()
  heights.clear()
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
})

it.each([1000, 10000])(
  "measures 100 tail resizes across %i turns without scanning history",
  async (count) => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
    })
    vi.stubGlobal("ResizeObserver", Observer)
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
      this: HTMLElement
    ) {
      return this.dataset.transcriptRow ? (heights.get(this.dataset.transcriptRow) ?? 120) : 480
    })
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(960)
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480)
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
      this: HTMLElement
    ) {
      return Math.max(
        480,
        Number.parseFloat(
          this.querySelector<HTMLElement>("[data-virtual-transcript]")?.style.height ?? "0"
        ) || 0
      )
    })
    vi.stubGlobal("scrollTo", () => {})
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo")
    HTMLElement.prototype.scrollTo = function (options) {
      if (typeof options === "object") {
        this.scrollTop = Math.max(0, Math.min(options.top ?? 0, this.scrollHeight - 480))
        queueMicrotask(() => {
          if (this.isConnected) this.dispatchEvent(new Event("scroll"))
        })
      }
    }
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    const rows: TranscriptRow[] = Array.from({ length: count }, (_, index) => ({
      id: `turn-${index}`,
      messageIds: [`prompt-${index}`],
      estimateSize: 120,
    }))
    const render = () =>
      root.render(
        <ConversationScrollerProvider>
          <ConversationScrollerViewport>
            <ConversationScrollerContent>
              <Profiler
                id="transcript"
                onRender={(_id, _phase, duration) => {
                  metrics.commits++
                  metrics.renderMs += duration
                }}
              >
                <VirtualTranscript rows={rows} renderRow={(index) => <p>{rows[index].id}</p>} />
              </Profiler>
            </ConversationScrollerContent>
          </ConversationScrollerViewport>
        </ConversationScrollerProvider>
      )
    const settle = async () => {
      await act(async () => {
        for (const observer of observers) observer.flush()
        await vi.advanceTimersByTimeAsync(100)
      })
    }
    try {
      act(render)
      await settle()
      await settle()
      Object.assign(metrics, {
        keys: 0,
        notifications: 0,
        measurements: 0,
        measurementMs: 0,
        refreshes: 0,
        commits: 0,
        renderMs: 0,
      })
      const viewport = container.querySelector<HTMLElement>(
        '[data-slot="message-scroller-viewport"]'
      )!
      const before = viewport.scrollTop
      for (let index = 1; index <= 100; index++) {
        heights.set(`turn-${count - 1}`, 120 + index * 12)
        act(render)
        await settle()
      }
      expect(viewport.scrollTop - before).toBe(1200)
      expect(metrics.keys).toBeLessThan(10000)
      expect(metrics.commits).toBeLessThan(150)
      expect(metrics.measurements).toBeLessThan(2000)
      console.info(
        JSON.stringify({
          scenario: "virtual-tail-100-growths",
          history: count,
          ...metrics,
          mounted: container.querySelectorAll("[data-transcript-row]").length,
        })
      )
    } finally {
      act(() => root.unmount())
      container.remove()
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollTo", original)
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo")
    }
  }
)
