import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BrowserDeveloperAction, BrowserDeveloperExecuteInput } from "@vykor/server"

const electronState = vi.hoisted(() => ({ fromId: vi.fn() }))

vi.mock("electron", () => ({
  webContents: { fromId: electronState.fromId },
}))

import { BrowserAgentService } from "./browser-agent-service"

class FakeDebugger extends EventEmitter {
  attached = false
  readonly commands: string[] = []
  private readonly handlers = new Map<string, (params: unknown) => unknown>()

  isAttached(): boolean {
    return this.attached
  }
  attach(): void {
    this.attached = true
  }
  detach(): void {
    this.attached = false
  }
  async sendCommand(method: string, params?: unknown): Promise<unknown> {
    this.commands.push(method)
    const handler = this.handlers.get(method)
    if (!handler) throw new Error(`unexpected CDP command: ${method}`)
    return handler(params)
  }
  respond(method: string, handler: (params: unknown) => unknown): void {
    this.handlers.set(method, handler)
  }
}

class FakePage extends EventEmitter {
  readonly id = 7
  url = "https://example.org/page"
  destroyed = false
  readonly debugger = new FakeDebugger()

  isDestroyed(): boolean {
    return this.destroyed
  }
  getURL(): string {
    return this.url
  }
}

function documentResponse(): unknown {
  return {
    root: {
      nodeId: 1,
      nodeType: 9,
      nodeName: "#document",
      children: [{ nodeId: 2, nodeType: 1, nodeName: "DIV", attributes: ["id", "app"], children: [] }],
    },
  }
}

function prepareDiagnostics(page: FakePage): void {
  page.debugger.respond("Page.enable", () => ({}))
  page.debugger.respond("Page.getFrameTree", () => ({ frameTree: { frame: { id: "MAIN" } } }))
  page.debugger.respond("Runtime.enable", () => ({}))
  page.debugger.respond("Network.enable", () => ({}))
}

function developerInput(
  action: BrowserDeveloperAction,
  overrides: Partial<BrowserDeveloperExecuteInput> = {}
): BrowserDeveloperExecuteInput {
  return {
    action,
    sessionId: "session-1",
    cwd: "D:/workspace",
    approveOrigin: vi.fn(async () => true),
    approveDeveloper: vi.fn(async () => true),
    ...overrides,
  }
}

function createHarness(mode: () => boolean) {
  const service = new BrowserAgentService({ isDeveloperModeEnabled: mode })
  const page = new FakePage()
  electronState.fromId.mockImplementation((id: number) => (id === page.id ? page : undefined))
  service.trackGuest(1, page as never)
  service.bindTab(1, "tab-1", page.id)
  service.setActiveTab(1, "tab-1")
  return { service, page }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("BrowserAgentService developer mode gate", () => {
  it("rejects before attaching when the Desktop switch is off", async () => {
    const { service, page } = createHarness(() => false)
    const input = developerInput({ action: "inspect_dom" })

    await expect(service.executeDeveloper(input)).rejects.toThrow(/developer mode/i)

    expect(page.debugger.attached).toBe(false)
    expect(input.approveOrigin).not.toHaveBeenCalled()
    expect(input.approveDeveloper).not.toHaveBeenCalled()
  })

  it("requires the ordinary site approval before the developer approval", async () => {
    const { service, page } = createHarness(() => true)
    page.debugger.respond("DOM.getDocument", () => documentResponse())
    const order: string[] = []
    const input = developerInput(
      { action: "inspect_dom" },
      {
        approveOrigin: vi.fn(async () => {
          order.push("origin")
          return true
        }),
        approveDeveloper: vi.fn(async (reason: string) => {
          order.push("developer")
          expect(reason).toContain("https://example.org")
          return true
        }),
      }
    )

    const result = await service.executeDeveloper(input)

    expect(order).toEqual(["origin", "developer"])
    expect(result).toMatchObject({ action: "inspect_dom", url: "https://example.org/page" })
  })

  it("reuses the ordinary session origin approval on later developer calls", async () => {
    const { service, page } = createHarness(() => true)
    page.debugger.respond("DOM.getDocument", () => documentResponse())
    const approveOrigin = vi.fn(async () => true)
    const approveDeveloper = vi.fn(async () => true)

    await service.executeDeveloper(
      developerInput({ action: "inspect_dom" }, { approveOrigin, approveDeveloper })
    )
    await service.executeDeveloper(
      developerInput({ action: "inspect_dom" }, { approveOrigin, approveDeveloper })
    )

    expect(approveOrigin).toHaveBeenCalledOnce()
    expect(approveDeveloper).toHaveBeenCalledTimes(2)
  })

  it("does not touch the debugger when the ordinary approval is refused", async () => {
    const { service, page } = createHarness(() => true)
    const input = developerInput(
      { action: "inspect_dom" },
      { approveOrigin: vi.fn(async () => false) }
    )

    await expect(service.executeDeveloper(input)).rejects.toThrow(/not approved/i)

    expect(input.approveDeveloper).not.toHaveBeenCalled()
    expect(page.debugger.attached).toBe(false)
  })

  it("does not touch the debugger when the developer approval is refused", async () => {
    const { service, page } = createHarness(() => true)
    const input = developerInput(
      { action: "inspect_dom" },
      { approveDeveloper: vi.fn(async () => false) }
    )

    await expect(service.executeDeveloper(input)).rejects.toThrow(/not approved/i)

    expect(page.debugger.attached).toBe(false)
  })

  it("names the workspace file in the developer approval prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "vk-developer-service-"))
    try {
      const workspace = join(root, "workspace")
      mkdirSync(workspace)
      const filePath = join(workspace, "page.html")
      writeFileSync(filePath, "<p>ok</p>")
      const { service, page } = createHarness(() => true)
      page.url = pathToFileURL(filePath).toString()
      let reason = ""
      const input = developerInput(
        { action: "inspect_dom" },
        {
          cwd: workspace,
          approveDeveloper: vi.fn(async (value: string) => {
            reason = value
            return true
          }),
        }
      )
      page.debugger.respond("DOM.getDocument", () => documentResponse())

      await service.executeDeveloper(input)

      expect(reason).toContain(filePath)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("refuses a file that escapes the workspace through a link", async () => {
    const root = mkdtempSync(join(tmpdir(), "vk-developer-service-link-"))
    try {
      const workspace = join(root, "workspace")
      const outside = join(root, "outside")
      mkdirSync(workspace)
      mkdirSync(outside)
      writeFileSync(join(outside, "secret.html"), "<p>secret</p>")
      const link = join(workspace, "link")
      try {
        symlinkSync(outside, link, "junction")
      } catch {
        return
      }
      const { service, page } = createHarness(() => true)
      page.url = pathToFileURL(join(link, "secret.html")).toString()
      const input = developerInput({ action: "inspect_dom" }, { cwd: workspace })

      await expect(service.executeDeveloper(input)).rejects.toThrow(/supports HTTP/i)
      expect(input.approveDeveloper).not.toHaveBeenCalled()
      expect(page.debugger.attached).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("aborts when the active tab changes while the developer approval waits", async () => {
    const { service, page } = createHarness(() => true)
    const input = developerInput(
      { action: "inspect_dom" },
      {
        approveDeveloper: vi.fn(async () => {
          service.setActiveTab(1, null)
          return true
        }),
      }
    )

    await expect(service.executeDeveloper(input)).rejects.toThrow(/active browser tab changed/i)
    expect(page.debugger.attached).toBe(false)
  })

  it("does not attach after Developer mode is disabled while approval waits", async () => {
    let enabled = true
    const { service, page } = createHarness(() => enabled)
    const input = developerInput(
      { action: "inspect_dom" },
      { approveDeveloper: vi.fn(async () => {
        enabled = false
        service.stopDeveloperDiagnostics()
        return true
      }) }
    )

    await expect(service.executeDeveloper(input)).rejects.toThrow(/developer mode/i)
    expect(page.debugger.commands).toHaveLength(0)
    expect(page.debugger.attached).toBe(false)
  })

  it("does not inspect an old guest after the active tab ID is rebound", async () => {
    const { service, page } = createHarness(() => true)
    const replacement = new FakePage()
    Object.defineProperty(replacement, "id", { value: 8 })
    electronState.fromId.mockImplementation((id: number) =>
      id === page.id ? page : id === replacement.id ? replacement : undefined
    )
    service.trackGuest(1, replacement as never)
    const input = developerInput(
      { action: "inspect_dom" },
      { approveDeveloper: vi.fn(async () => {
        service.bindTab(1, "tab-1", replacement.id)
        return true
      }) }
    )

    await expect(service.executeDeveloper(input)).rejects.toThrow(/browser tab changed/i)
    expect(page.debugger.commands).toHaveLength(0)
    expect(page.debugger.attached).toBe(false)
  })

  it("aborts when the page navigates while a read command runs", async () => {
    const { service, page } = createHarness(() => true)
    page.debugger.respond("DOM.getDocument", () => {
      page.url = "https://example.org/next"
      page.emit("did-start-navigation", {
        isMainFrame: true,
        isSameDocument: false,
        url: page.url,
      })
      return documentResponse()
    })

    await expect(
      service.executeDeveloper(developerInput({ action: "inspect_dom" }))
    ).rejects.toThrow(/page changed/i)
  })

  it("discards a read if the user switches away and back during the command", async () => {
    const { service, page } = createHarness(() => true)
    page.debugger.respond("DOM.getDocument", () => {
      service.setActiveTab(1, null)
      service.setActiveTab(1, "tab-1")
      return documentResponse()
    })

    await expect(
      service.executeDeveloper(developerInput({ action: "inspect_dom" }))
    ).rejects.toThrow(/tab changed/i)
    expect(page.debugger.attached).toBe(false)
  })

  it("returns a truncated DOM result instead of an oversized tool response", async () => {
    const { service, page } = createHarness(() => true)
    page.debugger.respond("DOM.getDocument", () => ({
      root: {
        nodeId: 1,
        nodeType: 9,
        nodeName: "#document",
        children: Array.from({ length: 149 }, (_, index) => ({
          nodeType: 1,
          nodeName: "DIV",
          attributes: ["data-a", "a".repeat(300), "data-b", "b".repeat(300)],
          children: [{ nodeType: 3, nodeName: "#text", nodeValue: `row-${index}` }],
        })),
      },
    }))

    const result = await service.executeDeveloper(developerInput({ action: "inspect_dom" }))

    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(48 * 1024)
  })

  it("returns truncated computed styles when their values exceed the result limit", async () => {
    const { service, page } = createHarness(() => true)
    page.debugger.respond("DOM.enable", () => ({}))
    page.debugger.respond("CSS.enable", () => ({}))
    page.debugger.respond("DOM.getDocument", () => documentResponse())
    page.debugger.respond("DOM.querySelector", () => ({ nodeId: 2 }))
    page.debugger.respond("DOM.describeNode", () => ({ node: { nodeName: "DIV" } }))
    page.debugger.respond("CSS.getComputedStyleForNode", () => ({
      computedStyle: Array.from({ length: 200 }, (_, index) => ({
        name: `property-${index}`,
        value: "v".repeat(300),
      })),
    }))

    const result = await service.executeDeveloper(
      developerInput({ action: "inspect_styles", selector: "#app" })
    )

    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(48 * 1024)
  })
})

describe("BrowserAgentService developer diagnostics", () => {
  it("starts a capture only after both approvals", async () => {
    const { service, page } = createHarness(() => true)
    prepareDiagnostics(page)
    const input = developerInput({ action: "start_diagnostics" })

    const result = await service.executeDeveloper(input)

    expect(input.approveOrigin).toHaveBeenCalledOnce()
    expect(input.approveDeveloper).toHaveBeenCalledOnce()
    expect(input.approveDeveloper).toHaveBeenCalledWith(
      expect.stringMatching(/third-party subresource URLs/i)
    )
    expect(result.data).toMatchObject({ expiresAt: expect.any(Number) })
    expect(page.debugger.attached).toBe(true)
  })

  it("bounds and sanitizes a long page URL in start and read results", async () => {
    const { service, page } = createHarness(() => true)
    page.url = `https://example.org/${"a".repeat(55_000)}?token=private`
    prepareDiagnostics(page)

    const started = await service.executeDeveloper(developerInput({ action: "start_diagnostics" }))
    const read = await service.executeDeveloper(developerInput({ action: "read_diagnostics" }))

    for (const result of [started, read]) {
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(48 * 1024)
      expect(JSON.stringify(result)).not.toContain("private")
    }
    service.stopDeveloperDiagnostics()
  })

  it("cleans up a capture when navigation invalidates it during startup", async () => {
    const { service, page } = createHarness(() => true)
    prepareDiagnostics(page)
    page.debugger.respond("Page.enable", () => {
      page.url = "https://example.org/next"
      page.emit("did-start-navigation", {
        isMainFrame: true,
        isSameDocument: false,
        url: page.url,
      })
      return {}
    })

    await expect(
      service.executeDeveloper(developerInput({ action: "start_diagnostics" }))
    ).rejects.toThrow(/page changed/i)
    expect(page.debugger.attached).toBe(false)
  })

  it("reads and stops without requesting new approvals", async () => {
    const { service, page } = createHarness(() => true)
    prepareDiagnostics(page)
    await service.executeDeveloper(developerInput({ action: "start_diagnostics" }))

    const readInput = developerInput({ action: "read_diagnostics" })
    const read = await service.executeDeveloper(readInput)
    expect(readInput.approveOrigin).not.toHaveBeenCalled()
    expect(readInput.approveDeveloper).not.toHaveBeenCalled()
    expect(read.data).toMatchObject({ scope: "https://example.org", console: [], network: [] })

    const stopInput = developerInput({ action: "stop_diagnostics" })
    const stopped = await service.executeDeveloper(stopInput)
    expect(stopInput.approveOrigin).not.toHaveBeenCalled()
    expect(stopped.data).toEqual({ stopped: true })
    expect(page.debugger.attached).toBe(false)
  })

  it("stops immediately while another browser operation waits for approval", async () => {
    const { service, page } = createHarness(() => true)
    prepareDiagnostics(page)
    await service.executeDeveloper(developerInput({ action: "start_diagnostics" }))
    let releaseApproval: (allowed: boolean) => void = () => undefined
    const approvalStarted = vi.fn()
    const pending = service.executeDeveloper(developerInput(
      { action: "inspect_dom" },
      { approveDeveloper: () => new Promise((resolve) => {
        releaseApproval = resolve
        approvalStarted()
      }) }
    ))
    await vi.waitFor(() => expect(approvalStarted).toHaveBeenCalledOnce())

    const stop = service.executeDeveloper(developerInput({ action: "stop_diagnostics" }))
    try {
      await Promise.resolve()
      expect(page.debugger.attached).toBe(false)
    } finally {
      releaseApproval(false)
      await Promise.allSettled([pending, stop])
    }
  })

  it("cancels a pending capture before it can attach after approval", async () => {
    const { service, page } = createHarness(() => true)
    prepareDiagnostics(page)
    let releaseApproval: (allowed: boolean) => void = () => undefined
    const approvalStarted = vi.fn()
    const pending = service.executeDeveloper(developerInput(
      { action: "start_diagnostics" },
      { approveDeveloper: () => new Promise((resolve) => {
        releaseApproval = resolve
        approvalStarted()
      }) }
    ))
    await vi.waitFor(() => expect(approvalStarted).toHaveBeenCalledOnce())

    const stop = await service.executeDeveloper(developerInput({ action: "stop_diagnostics" }))
    expect(stop.data).toEqual({ stopped: false })
    releaseApproval(true)

    await expect(pending).rejects.toThrow(/tab changed|stopped/i)
    expect(page.debugger.attached).toBe(false)
  })

  it("does not let another session cancel a pending capture", async () => {
    const { service, page } = createHarness(() => true)
    prepareDiagnostics(page)
    let releaseApproval: (allowed: boolean) => void = () => undefined
    const approvalStarted = vi.fn()
    const pending = service.executeDeveloper(developerInput(
      { action: "start_diagnostics" },
      { approveDeveloper: () => new Promise((resolve) => {
        releaseApproval = resolve
        approvalStarted()
      }) }
    ))
    await vi.waitFor(() => expect(approvalStarted).toHaveBeenCalledOnce())

    await expect(service.executeDeveloper(
      developerInput({ action: "stop_diagnostics" }, { sessionId: "session-2" })
    )).rejects.toThrow(/another session/i)
    releaseApproval(true)

    await expect(pending).resolves.toMatchObject({ action: "start_diagnostics" })
    expect(page.debugger.attached).toBe(true)
    service.stopDeveloperDiagnostics()
  })

  it("cancels a capture queued behind a Browser approval", async () => {
    const { service, page } = createHarness(() => true)
    prepareDiagnostics(page)
    let releaseBrowser: (allowed: boolean) => void = () => undefined
    const browserApprovalStarted = vi.fn()
    const browserOperation = service.execute({
      action: { action: "inspect" },
      sessionId: "session-1",
      cwd: "D:/workspace",
      includeScreenshot: false,
      approve: () => new Promise((resolve) => {
        releaseBrowser = resolve
        browserApprovalStarted()
      }),
    })
    await vi.waitFor(() => expect(browserApprovalStarted).toHaveBeenCalledOnce())
    const queuedStart = service.executeDeveloper(developerInput({ action: "start_diagnostics" }))

    const stop = await service.executeDeveloper(developerInput({ action: "stop_diagnostics" }))
    expect(stop.data).toEqual({ stopped: false })
    releaseBrowser(false)
    await expect(browserOperation).rejects.toThrow(/not approved/i)
    await expect(queuedStart).rejects.toThrow(/stopped|cancelled/i)
    expect(page.debugger.attached).toBe(false)
  })

  it("keeps the whole diagnostics result below the Server limit on a busy page", async () => {
    const { service, page } = createHarness(() => true)
    page.url = `https://example.org/${"p".repeat(275)}`
    prepareDiagnostics(page)
    await service.executeDeveloper(developerInput({ action: "start_diagnostics" }))
    for (let index = 0; index < 200; index += 1) {
      const requestId = `r${index}`
      page.debugger.emit("message", {}, "Network.requestWillBeSent", {
        frameId: "MAIN",
        requestId,
        type: "XHR",
        timestamp: 1_000,
        request: { method: "GET", url: `https://cdn.example.org/${"x".repeat(270)}${index}` },
      }, "")
      page.debugger.emit("message", {}, "Network.loadingFinished", {
        requestId,
        timestamp: 1_000.1,
      }, "")
    }

    const result = await service.executeDeveloper(developerInput({ action: "read_diagnostics" }))

    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(48 * 1024)
    service.stopDeveloperDiagnostics()
  })

  it("refuses a second session taking over the capture", async () => {
    const { service, page } = createHarness(() => true)
    prepareDiagnostics(page)
    await service.executeDeveloper(developerInput({ action: "start_diagnostics" }))

    await expect(
      service.executeDeveloper(
        developerInput({ action: "start_diagnostics" }, { sessionId: "session-2" })
      )
    ).rejects.toThrow(/Another session/i)
  })

  it("does not let another session stop a capture or read the active URL", async () => {
    const { service, page } = createHarness(() => true)
    page.url = "https://example.org/page?token=private"
    prepareDiagnostics(page)
    await service.executeDeveloper(developerInput({ action: "start_diagnostics" }))

    await expect(
      service.executeDeveloper(
        developerInput({ action: "stop_diagnostics" }, { sessionId: "session-2" })
      )
    ).rejects.toThrow(/another session|does not own/i)
    expect(page.debugger.attached).toBe(true)

    const stopped = await service.executeDeveloper(developerInput({ action: "stop_diagnostics" }))
    expect(stopped.url).toBe("")
    expect(page.debugger.attached).toBe(false)
  })

  it("stops the capture when developer mode is turned off", async () => {
    let enabled = true
    const { service, page } = createHarness(() => enabled)
    prepareDiagnostics(page)
    await service.executeDeveloper(developerInput({ action: "start_diagnostics" }))

    enabled = false
    await expect(
      service.executeDeveloper(developerInput({ action: "read_diagnostics" }))
    ).rejects.toThrow(/developer mode/i)
    expect(page.debugger.attached).toBe(false)
  })

  it("stops the capture through the immediate settings hook", async () => {
    const { service, page } = createHarness(() => true)
    prepareDiagnostics(page)
    await service.executeDeveloper(developerInput({ action: "start_diagnostics" }))

    expect(service.stopDeveloperDiagnostics()).toBe(true)

    expect(page.debugger.attached).toBe(false)
    await expect(
      service.executeDeveloper(developerInput({ action: "read_diagnostics" }))
    ).rejects.toThrow(/no browser diagnostics capture is active/i)
  })

  it("stops the capture when the active tab changes", async () => {
    const { service, page } = createHarness(() => true)
    prepareDiagnostics(page)
    await service.executeDeveloper(developerInput({ action: "start_diagnostics" }))

    service.setActiveTab(1, null)

    expect(page.debugger.attached).toBe(false)
  })

  it("stops capture on the old guest when the active tab is rebound", async () => {
    const { service, page } = createHarness(() => true)
    prepareDiagnostics(page)
    await service.executeDeveloper(developerInput({ action: "start_diagnostics" }))
    const replacement = new FakePage()
    Object.defineProperty(replacement, "id", { value: 8 })
    service.trackGuest(1, replacement as never)

    service.bindTab(1, "tab-1", replacement.id)

    expect(page.debugger.attached).toBe(false)
  })

  it("stops capture when a same-origin navigation redirects across origins", async () => {
    const { service, page } = createHarness(() => true)
    prepareDiagnostics(page)
    await service.executeDeveloper(developerInput({ action: "start_diagnostics" }))

    page.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
      url: "https://example.org/next",
    })
    page.emit("did-redirect-navigation", {
      isMainFrame: true,
      isSameDocument: false,
      url: "https://other.example/next",
    })

    expect(page.debugger.attached).toBe(false)
  })
})
