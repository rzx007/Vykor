import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"

const electronState = vi.hoisted(() => ({ fromId: vi.fn() }))

vi.mock("electron", () => ({
  webContents: { fromId: electronState.fromId },
}))

import { BrowserAgentService } from "./browser-agent-service"

type FakeElement = {
  index: number
  selector: string
  role: string
  name: string
  href: string
  value: string
  requiresConfirmation: boolean
}

class FakeWebContents extends EventEmitter {
  readonly id = 42
  url = "http://127.0.0.1:8080/index.html"
  title = "Browser fixture"
  pageText = "before click"
  loading = false
  href = ""
  requiresConfirmation = false
  dispatchClickBeforeScriptResult = false
  clickBehavior: ((page: FakeWebContents) => void) | undefined
  captureCount = 0

  isDestroyed(): boolean { return false }
  getURL(): string { return this.url }
  isLoading(): boolean { return this.loading }
  capturePage(): Promise<{ toPNG: () => Buffer }> {
    this.captureCount++
    return Promise.resolve({ toPNG: () => Buffer.from("screenshot") })
  }

  async executeJavaScript<T = unknown>(script: string): Promise<T> {
    if (script.includes("document.querySelectorAll")) {
      return {
        url: this.url,
        title: this.title,
        pageText: this.pageText,
        elements: [this.element()],
      } as T
    }
    if (script.includes("el.click()") || script.includes("target.click()")) {
      if (!script.includes("setTimeout")) {
        // Simulate Electron losing the execution context when click navigates.
        throw new Error("Script failed to execute. This normally means an error was thrown.")
      }
      if (this.dispatchClickBeforeScriptResult) this.clickBehavior?.(this)
      else setTimeout(() => this.clickBehavior?.(this), 0)
      return "click queued" as T
    }
    if (script.includes("window.scrollBy")) return undefined as T
    throw new Error(`Unexpected browser script: ${script.slice(0, 80)}`)
  }

  private element(): FakeElement {
    return {
      index: 0,
      selector: "#action",
      role: "button",
      name: "Continue",
      href: this.href,
      value: "",
      requiresConfirmation: this.requiresConfirmation,
    }
  }
}

function navigate(page: FakeWebContents, url: string, text: string): void {
  const event = { preventDefault: vi.fn() }
  page.emit("will-navigate", event, url)
  if (event.preventDefault.mock.calls.length > 0) return
  page.loading = true
  page.emit("did-start-loading")
  page.url = url
  page.pageText = text
  page.emit("did-navigate", {}, url)
  setTimeout(() => {
    page.loading = false
    page.emit("did-stop-loading")
  }, 10)
}

async function inspect(service: BrowserAgentService) {
  return await service.execute({
    action: { action: "inspect" },
    sessionId: "session-1",
    cwd: "D:/workspace",
    includeScreenshot: false,
    approve: async () => true,
  })
}

describe("BrowserAgentService click actions", () => {
  let service: BrowserAgentService
  let page: FakeWebContents

  beforeEach(() => {
    vi.clearAllMocks()
    service = new BrowserAgentService()
    page = new FakeWebContents()
    electronState.fromId.mockImplementation((id: number) => id === page.id ? page : undefined)
    service.trackGuest(7, page as never)
    service.bindTab(7, "browser-tab-1", page.id)
    service.setActiveTab(7, "browser-tab-1")
  })

  it("clicks an ordinary button whose DOM changes without navigation", async () => {
    page.clickBehavior = (current) => { current.pageText = "ordinary button clicked" }
    const before = await inspect(service)

    const after = await service.execute({
      action: { action: "click", elementId: before.elements![0]!.id },
      sessionId: "session-1",
      cwd: "D:/workspace",
      includeScreenshot: false,
      approve: async () => true,
    })

    expect(after.pageText).toBe("ordinary button clicked")
  })

  it("clicks a submit button that navigates and waits for the new page", async () => {
    page.clickBehavior = (current) => navigate(current, "http://127.0.0.1:8080/result.html", "form submitted")
    page.requiresConfirmation = true
    page.dispatchClickBeforeScriptResult = true
    const before = await inspect(service)
    page.pageText = "before click"
    const target = before.elements![0]!
    service.addAnnotation(7, "browser-tab-1", { target: target.name, comment: "submit" })

    const after = await service.execute({
      action: { action: "click", elementId: target.id },
      sessionId: "session-1",
      cwd: "D:/workspace",
      includeScreenshot: false,
      approve: async () => true,
    })

    expect(after.url).toBe("http://127.0.0.1:8080/result.html")
    expect(after.pageText).toBe("form submitted")
  })

  it("clicks a link after authorizing its external origin", async () => {
    page.href = "https://example.org/next"
    page.clickBehavior = (current) => navigate(current, "https://example.org/next", "linked page")
    const before = await inspect(service)
    const target = before.elements![0]!
    page.clickBehavior = (current) => navigate(current, "https://example.org/next", "linked page")

    const after = await service.execute({
      action: { action: "click", elementId: target.id },
      sessionId: "session-1",
      cwd: "D:/workspace",
      includeScreenshot: false,
      approve: async () => true,
    })

    expect(after.url).toBe("https://example.org/next")
    expect(after.pageText).toBe("linked page")
  })

  it("observes a delayed SPA update after clicking without a URL change", async () => {
    page.clickBehavior = (current) => {
      setTimeout(() => { current.pageText = "updated without navigation" }, 280)
    }
    const before = await inspect(service)

    const after = await service.execute({
      action: { action: "click", elementId: before.elements![0]!.id },
      sessionId: "session-1",
      cwd: "D:/workspace",
      includeScreenshot: false,
      approve: async () => true,
    })

    expect(after.url).toBe(before.url)
    expect(after.pageText).toBe("updated without navigation")
  })
})

describe("BrowserAgentService screenshot capability", () => {
  it("does not capture an inspect screenshot when the model is non-visual", async () => {
    const service = new BrowserAgentService()
    const page = new FakeWebContents()
    electronState.fromId.mockImplementation((id: number) => id === page.id ? page : undefined)
    service.trackGuest(7, page as never)
    service.bindTab(7, "browser-tab-1", page.id)
    service.setActiveTab(7, "browser-tab-1")

    const result = await service.execute({
      action: { action: "inspect" },
      sessionId: "session-1",
      cwd: "D:/workspace",
      includeScreenshot: false,
      approve: async () => true,
    })

    expect(page.captureCount).toBe(0)
    expect(result.screenshotBytes).toBeUndefined()
  })

  it("captures inspect screenshots when the model supports image input", async () => {
    const service = new BrowserAgentService()
    const page = new FakeWebContents()
    electronState.fromId.mockImplementation((id: number) => id === page.id ? page : undefined)
    service.trackGuest(7, page as never)
    service.bindTab(7, "browser-tab-1", page.id)
    service.setActiveTab(7, "browser-tab-1")

    const result = await service.execute({
      action: { action: "inspect" },
      sessionId: "session-1",
      cwd: "D:/workspace",
      includeScreenshot: true,
      approve: async () => true,
    })

    expect(page.captureCount).toBe(1)
    expect(result.screenshotBytes).toEqual(Buffer.from("screenshot"))
  })
})
