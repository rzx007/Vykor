import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"

const electronState = vi.hoisted(() => ({ fromId: vi.fn() }))

vi.mock("electron", () => ({
  webContents: { fromId: electronState.fromId },
}))

import { BrowserAgentService } from "./browser-agent-service"
import type { PageAnnotationCommand } from "../../../shared/browser-annotation"

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
  annotationSelected = false
  annotationMode = "off"
  annotationMarkers: Array<{ id: string }> = []

  isDestroyed(): boolean {
    return false
  }
  getURL(): string {
    return this.url
  }
  isLoading(): boolean {
    return this.loading
  }
  capturePage(): Promise<{ toPNG: () => Buffer }> {
    this.captureCount++
    return Promise.resolve({ toPNG: () => Buffer.from("screenshot") })
  }

  async loadURL(url: string): Promise<void> {
    navigate(this, url, "navigated by agent")
  }

  async executeJavaScript<T = unknown>(script: string): Promise<T> {
    // Compile generated action code before simulating its effects, as the actual guest does.
    new Function(script)
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

  async executeJavaScriptInIsolatedWorld<T>(
    _world: number,
    scripts: Array<{ code: string }>
  ): Promise<T> {
    const code = scripts[0].code
    const command = JSON.parse(code.slice(code.lastIndexOf(")(") + 2, -1)) as PageAnnotationCommand
    if (command.action === "install") this.annotationMode = command.mode
    if (command.action === "stop") {
      this.annotationMode = "off"
      this.annotationSelected = false
    }
    if (command.action === "syncMarkers") {
      this.annotationMarkers = command.markers
      this.annotationSelected = false
    }
    return {
      mode: this.annotationMode,
      interactionVersion: command.interactionVersion,
      eventSequence: this.annotationSelected ? 1 : 0,
      selected: this.annotationSelected
        ? {
            handleId: "h-1",
            target: "button: Continue",
            selector: "#action",
            locatorKind: "unique-id",
            tagName: "button",
            role: "button",
            name: "Continue",
            rect: { x: 10, y: 20, width: 80, height: 30 },
          }
        : null,
      focusedAnnotationId: null,
      viewport: { width: 800, height: 600 },
      markers: this.annotationMarkers.map((m) => ({
        id: m.id,
        status: "visible",
        rect: { x: 10, y: 20, width: 80, height: 30 },
      })),
    } as T
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
    electronState.fromId.mockImplementation((id: number) => (id === page.id ? page : undefined))
    service.trackGuest(7, page as never)
    service.bindTab(7, "browser-tab-1", page.id)
    service.setActiveTab(7, "browser-tab-1")
  })

  it("asks again after a saved site approval is revoked", async () => {
    await inspect(service)
    expect(service.listOriginApprovals()).toEqual([{ sessionId: "session-1", origin: "http://127.0.0.1:8080" }])
    service.revokeOriginApproval("session-1", "http://127.0.0.1:8080")
    expect(service.listOriginApprovals()).toEqual([])
    await expect(service.execute({ action: { action: "inspect" }, sessionId: "session-1", cwd: "D:/workspace",
      includeScreenshot: false, approve: async () => false })).rejects.toThrow("not approved")
  })

  it("clicks an ordinary button whose DOM changes without navigation", async () => {
    page.clickBehavior = (current) => {
      current.pageText = "ordinary button clicked"
    }
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
    page.clickBehavior = (current) =>
      navigate(current, "http://127.0.0.1:8080/result.html", "form submitted")
    page.requiresConfirmation = true
    page.dispatchClickBeforeScriptResult = true
    const before = await inspect(service)
    page.pageText = "before click"
    const target = before.elements![0]!

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
      setTimeout(() => {
        current.pageText = "updated without navigation"
      }, 280)
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

describe("Browser annotation ownership and lifecycle", () => {
  let service: BrowserAgentService, page: FakeWebContents
  beforeEach(() => {
    page = new FakeWebContents()
    service = new BrowserAgentService()
    electronState.fromId.mockImplementation((id: number) => (id === page.id ? page : undefined))
    service.trackGuest(7, page as never)
    service.bindTab(7, "tab-1", page.id)
    service.setActiveTab(7, "tab-1")
  })
  async function save() {
    const initial = await service.readAnnotations(7, "tab-1")
    await service.setAnnotationMode(7, {
      tabId: "tab-1",
      pageRevision: initial.pageRevision,
      mode: "pick",
    })
    page.annotationSelected = true
    const selected = await service.readAnnotations(7, "tab-1")
    return await service.addAnnotation(7, {
      tabId: "tab-1",
      pageRevision: selected.pageRevision,
      selectionId: selected.selection!.selectionId,
      comment: "修改按钮",
    })
  }
  it("checks the actual window and active tab before reading annotation data", async () => {
    await expect(service.readAnnotations(8, "tab-1")).rejects.toThrow()
    service.setActiveTab(7, null)
    await expect(service.readAnnotations(7, "tab-1")).rejects.toThrow()
  })
  it("preserves records on same-guest rebind and ignores child-frame navigation", async () => {
    await save()
    service.unbindTab(7, "tab-1")
    service.bindTab(7, "tab-1", page.id)
    service.setActiveTab(7, "tab-1")
    page.emit("did-navigate-in-page", {}, "http://child/", false)
    expect((await service.readAnnotations(7, "tab-1")).annotations).toHaveLength(1)
    expect((await inspect(service)).annotations).toEqual([
      { target: "button: Continue", selector: "#action", comment: "修改按钮" },
    ])
  })
  it("invalidates selections and records on main-frame address changes", async () => {
    await save()
    page.url = "http://127.0.0.1:8080/new"
    page.emit("did-navigate-in-page", {}, page.url, true)
    expect((await service.readAnnotations(7, "tab-1")).annotations).toEqual([])
  })
  it("keeps the user's picker open when a high-impact Agent action is denied", async () => {
    await save(); page.requiresConfirmation = true
    const observed = await inspect(service)
    await expect(service.execute({ action: { action: "click", elementId: observed.elements![0].id }, sessionId: "session-1", cwd: "D:/workspace", includeScreenshot: false, approve: async () => false })).rejects.toThrow(/not approved/)
    expect((await service.readAnnotations(7, "tab-1")).mode).toBe("pick")
  })
})

describe("BrowserAgentService screenshot capability", () => {
  it("does not capture an inspect screenshot when the model is non-visual", async () => {
    const service = new BrowserAgentService()
    const page = new FakeWebContents()
    electronState.fromId.mockImplementation((id: number) => (id === page.id ? page : undefined))
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
    electronState.fromId.mockImplementation((id: number) => (id === page.id ? page : undefined))
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

describe("BrowserAgentService cold start", () => {
  it("opens a blank tab, requests origin approval, then navigates to the requested URL", async () => {
    const service = new BrowserAgentService()
    const page = new FakeWebContents()
    let tabRequestSent = false
    electronState.fromId.mockImplementation((id: number) => (id === page.id ? page : undefined))
    service.setOpenTabRequestHandler(() => {
      tabRequestSent = true
      service.trackGuest(7, page as never)
      service.bindTab(7, "browser-tab-cold", page.id)
      service.setActiveTab(7, "browser-tab-cold")
    })
    const approve = vi.fn(async () => {
      expect(tabRequestSent).toBe(false)
      return true
    })

    const result = await service.execute({
      action: { action: "navigate", url: "https://example.org/start" },
      sessionId: "session-cold",
      cwd: "D:/workspace",
      includeScreenshot: false,
      approve,
    })

    expect(approve).toHaveBeenCalledOnce()
    expect(tabRequestSent).toBe(true)
    expect(result.url).toBe("https://example.org/start")
    expect(result.pageText).toBe("navigated by agent")
  })

  it("does not create a tab for inspection without a page", async () => {
    const service = new BrowserAgentService()
    const openTab = vi.fn()
    service.setOpenTabRequestHandler(openTab)

    await expect(
      service.execute({
        action: { action: "inspect" },
        sessionId: "session-cold",
        cwd: "D:/workspace",
        includeScreenshot: false,
        approve: async () => true,
      })
    ).rejects.toThrow("Use Browser navigate with a URL to open a page.")
    expect(openTab).not.toHaveBeenCalled()
  })
})
