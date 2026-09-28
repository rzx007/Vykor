import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it, vi } from "vitest"

import {
  BrowserDeveloperInspector,
  resolveDeveloperScope,
  sanitizeUrl,
  type DeveloperGuest,
} from "./browser-developer-inspector"

class FakeDebugger extends EventEmitter {
  attached = false
  attachError: Error | undefined
  readonly commands: Array<{ method: string; params?: unknown }> = []
  private readonly handlers = new Map<string, (params: unknown) => unknown>()

  isAttached(): boolean {
    return this.attached
  }
  attach(): void {
    if (this.attachError) throw this.attachError
    this.attached = true
  }
  detach(): void {
    this.attached = false
  }
  async sendCommand(method: string, params?: unknown): Promise<unknown> {
    this.commands.push({ method, params })
    const handler = this.handlers.get(method)
    if (!handler) throw new Error(`unexpected CDP command: ${method}`)
    return handler(params)
  }
  respond(method: string, handler: (params: unknown) => unknown): void {
    this.handlers.set(method, handler)
  }
  emitMessage(method: string, params: unknown, sessionId = ""): void {
    this.emit("message", {}, method, params, sessionId)
  }
}

class FakeGuest extends EventEmitter implements DeveloperGuest {
  readonly id = 42
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

function guest(): FakeGuest {
  return new FakeGuest()
}

function documentResponse(): unknown {
  return {
    root: {
      nodeId: 1,
      nodeType: 9,
      nodeName: "#document",
      children: [
        {
          nodeId: 2,
          nodeType: 1,
          nodeName: "INPUT",
          attributes: ["type", "password", "value", "hunter2", "data-token", "abc", "id", "pw"],
          children: [],
        },
        { nodeId: 3, nodeType: 1, nodeName: "BUTTON", attributes: ["id", "go"], children: [] },
      ],
    },
  }
}

function prepareDiagnosticsHandlers(page: FakeGuest): void {
  page.debugger.respond("Page.enable", () => ({}))
  page.debugger.respond("Page.getFrameTree", () => ({ frameTree: { frame: { id: "MAIN" } } }))
  page.debugger.respond("Runtime.enable", () => ({}))
  page.debugger.respond("Network.enable", () => ({}))
}

describe("resolveDeveloperScope", () => {
  it("accepts an http(s) origin and rejects unsupported protocols", () => {
    expect(resolveDeveloperScope("https://example.org/a?b=1#c", "D:/workspace")).toEqual({
      kind: "http",
      scope: "https://example.org",
      url: "https://example.org/a?b=1#c",
    })
    expect(resolveDeveloperScope("about:blank", "D:/workspace")).toBeNull()
    expect(resolveDeveloperScope("not a url", "D:/workspace")).toBeNull()
  })

  it("accepts a workspace-local file and rejects one outside the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "vk-developer-scope-"))
    try {
      const workspace = join(root, "workspace")
      const outside = join(root, "outside")
      mkdirSync(workspace)
      mkdirSync(outside)
      writeFileSync(join(workspace, "page.html"), "<p>ok</p>")
      writeFileSync(join(outside, "secret.html"), "<p>secret</p>")
      const insideUrl = pathToFileURL(join(workspace, "page.html")).toString()
      const outsideUrl = pathToFileURL(join(outside, "secret.html")).toString()

      expect(resolveDeveloperScope(insideUrl, workspace)).toMatchObject({ kind: "file" })
      expect(resolveDeveloperScope(outsideUrl, workspace)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects a workspace file that escapes through a link", () => {
    const root = mkdtempSync(join(tmpdir(), "vk-developer-link-"))
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
        // The platform cannot create links without elevation; nothing to assert.
        return
      }
      const escaped = pathToFileURL(join(link, "secret.html")).toString()
      expect(resolveDeveloperScope(escaped, workspace)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("BrowserDeveloperInspector single-shot reads", () => {
  it("attaches for a read and detaches afterwards when no capture is active", async () => {
    const page = guest()
    page.debugger.respond("DOM.getDocument", () => documentResponse())
    const inspector = new BrowserDeveloperInspector()

    const result = await inspector.inspectDom(page)

    expect(page.debugger.attached).toBe(false)
    const document = result.document
    expect(document?.children?.[0]).toMatchObject({ name: "input" })
  })

  it("redacts sensitive attribute values but keeps ordinary ones", async () => {
    const page = guest()
    page.debugger.respond("DOM.getDocument", () => documentResponse())
    const inspector = new BrowserDeveloperInspector()

    const result = await inspector.inspectDom(page)
    const input = result.document?.children?.[0]

    expect(input?.attributes?.value).toBe("[redacted]")
    expect(input?.attributes?.["data-token"]).toBe("[redacted]")
    expect(input?.attributes?.id).toBe("pw")
    const button = result.document?.children?.[1]
    expect(button?.attributes?.id).toBe("go")
  })

  it("resolves a selector through querySelector and describeNode", async () => {
    const page = guest()
    page.debugger.respond("DOM.getDocument", () => documentResponse())
    page.debugger.respond("DOM.querySelector", () => ({ nodeId: 3 }))
    page.debugger.respond("DOM.describeNode", () => ({
      node: { nodeId: 3, nodeType: 1, nodeName: "BUTTON", attributes: ["id", "go"] },
    }))
    const inspector = new BrowserDeveloperInspector()

    const result = await inspector.inspectDom(page, "#go")

    expect(result.found).toBe(true)
    expect(result.node).toMatchObject({ name: "button", attributes: { id: "go" } })
  })

  it("includes descendants of a selected DOM node", async () => {
    const page = guest()
    page.debugger.respond("DOM.getDocument", () => documentResponse())
    page.debugger.respond("DOM.querySelector", () => ({ nodeId: 3 }))
    page.debugger.respond("DOM.describeNode", () => ({
      node: {
        nodeId: 3,
        nodeType: 1,
        nodeName: "BUTTON",
        children: [{
          nodeType: 1,
          nodeName: "SPAN",
          children: [{ nodeType: 3, nodeName: "#text", nodeValue: "Save" }],
        }],
      },
    }))

    const result = await new BrowserDeveloperInspector().inspectDom(page, "button")

    expect(result.node?.children?.[0]).toMatchObject({
      name: "span",
      children: [{ name: "#text", text: "Save" }],
    })
  })

  it("reports a missing selector match without throwing", async () => {
    const page = guest()
    page.debugger.respond("DOM.getDocument", () => documentResponse())
    page.debugger.respond("DOM.querySelector", () => ({ nodeId: 0 }))
    const inspector = new BrowserDeveloperInspector()

    await expect(inspector.inspectDom(page, ".missing")).resolves.toMatchObject({ found: false })
  })

  it("bounds computed style properties", async () => {
    const page = guest()
    page.debugger.respond("DOM.enable", () => ({}))
    page.debugger.respond("CSS.enable", () => ({}))
    page.debugger.respond("DOM.getDocument", () => documentResponse())
    page.debugger.respond("DOM.querySelector", () => ({ nodeId: 3 }))
    page.debugger.respond("DOM.describeNode", () => ({
      node: { nodeId: 3, nodeType: 1, nodeName: "BUTTON" },
    }))
    page.debugger.respond("CSS.getComputedStyleForNode", () => ({
      computedStyle: Array.from({ length: 500 }, (_, index) => ({
        name: `prop-${index}`,
        value: "v".repeat(1000),
      })),
    }))
    const inspector = new BrowserDeveloperInspector()

    const result = await inspector.inspectStyles(page, "#go")

    expect(result.found).toBe(true)
    expect(result.properties).toHaveLength(200)
    expect(result.properties?.[0]?.value).toHaveLength(300)
  })

  it("refuses to steal a debugger that another owner already attached", async () => {
    const page = guest()
    page.debugger.attached = true
    const inspector = new BrowserDeveloperInspector()

    await expect(inspector.inspectDom(page)).rejects.toThrow(/already being debugged/)
  })
})

describe("BrowserDeveloperInspector diagnostics", () => {
  function started(options: { now?: () => number } = {}) {
    const page = guest()
    let clock = 1_000
    const now = options.now ?? (() => clock)
    const inspector = new BrowserDeveloperInspector({ now })
    prepareDiagnosticsHandlers(page)
    return {
      page,
      inspector,
      setNow(value: number) {
        clock = value
      },
      async start(sessionId = "session-1", epoch = 1) {
        await inspector.startDiagnostics(page, {
          sessionId,
          tabId: "browser-tab-1",
          scope: "https://example.org",
          cwd: process.cwd(),
          url: "https://example.org/page",
          navigationEpoch: epoch,
        })
      },
    }
  }

  it("registers events only after attach and enables the fixed domains", async () => {
    const harness = started()
    await harness.start()

    expect(harness.inspector.active).toBe(true)
    expect(harness.page.debugger.attached).toBe(true)
    expect(harness.page.debugger.commands.map((command) => command.method)).toEqual([
      "Page.enable",
      "Page.getFrameTree",
      "Runtime.enable",
      "Network.enable",
    ])
  })

  it("keeps only main-frame default-context console messages after approval", async () => {
    const harness = started()
    await harness.start()
    const debuggerClient = harness.page.debugger

    debuggerClient.emitMessage("Runtime.executionContextCreated", {
      context: { id: 1, auxData: { isDefault: true, frameId: "MAIN" } },
    })
    debuggerClient.emitMessage("Runtime.executionContextCreated", {
      context: { id: 2, auxData: { isDefault: true, frameId: "SUB" } },
    })
    // Replayed earlier message: timestamp predates approval.
    debuggerClient.emitMessage("Runtime.consoleAPICalled", {
      executionContextId: 1,
      type: "log",
      timestamp: 1,
      args: [{ type: "string", value: "too early" }],
    })
    debuggerClient.emitMessage("Runtime.consoleAPICalled", {
      executionContextId: 1,
      type: "log",
      timestamp: 2_000,
      args: [{ type: "string", value: "main frame" }],
    })
    debuggerClient.emitMessage("Runtime.consoleAPICalled", {
      executionContextId: 2,
      type: "log",
      timestamp: 2_000,
      args: [{ type: "string", value: "sub frame" }],
    })

    const page = harness.inspector.readDiagnostics(harness.page, {
      sessionId: "session-1",
      scope: "https://example.org",
      navigationEpoch: 1,
    })

    expect(page.console).toEqual([{ type: "log", text: "main frame", at: 2_000 }])
  })

  it("projects only bounded network metadata for main-frame requests", async () => {
    const harness = started()
    await harness.start()
    const debuggerClient = harness.page.debugger

    debuggerClient.emitMessage("Network.requestWillBeSent", {
      frameId: "MAIN",
      requestId: "r1",
      type: "XHR",
      timestamp: 1_000,
      request: {
        method: "POST",
        url: "https://example.org/api?token=secret#frag",
        headers: { Cookie: "session=secret", Authorization: "Bearer secret" },
        postData: "password=hunter2",
      },
    })
    debuggerClient.emitMessage("Network.responseReceived", {
      requestId: "r1",
      type: "XHR",
      response: { status: 500, headers: { "set-cookie": "a=b" } },
    })
    debuggerClient.emitMessage("Network.loadingFinished", { requestId: "r1", timestamp: 1_000.05 })
    // A subframe request must never enter the buffer.
    debuggerClient.emitMessage("Network.requestWillBeSent", {
      frameId: "SUB",
      requestId: "r2",
      type: "Script",
      timestamp: 2_000,
      request: { method: "GET", url: "https://cdn.example.org/x.js" },
    })
    debuggerClient.emitMessage("Network.loadingFinished", { requestId: "r2", timestamp: 2.05 })

    const page = harness.inspector.readDiagnostics(harness.page, {
      sessionId: "session-1",
      scope: "https://example.org",
      navigationEpoch: 1,
    })

    expect(page.network).toEqual([
      { method: "POST", url: "https://example.org/api", type: "XHR", status: 500, durationMs: 50 },
    ])
    const serialized = JSON.stringify(page)
    expect(serialized).not.toContain("secret")
    expect(serialized).not.toContain("Cookie")
    expect(serialized).not.toContain("Authorization")
    expect(serialized).not.toContain("hunter2")
    expect(serialized).not.toContain("set-cookie")
  })

  it("records a failed request with its failure reason", async () => {
    const harness = started()
    await harness.start()
    const debuggerClient = harness.page.debugger
    debuggerClient.emitMessage("Network.requestWillBeSent", {
      frameId: "MAIN",
      requestId: "r1",
      type: "Fetch",
      timestamp: 1_000,
      request: { method: "GET", url: "https://example.org/fail" },
    })
    debuggerClient.emitMessage("Network.loadingFailed", {
      requestId: "r1",
      timestamp: 1_000.01,
      errorText: "net::ERR_ABORTED",
    })

    const page = harness.inspector.readDiagnostics(harness.page, {
      sessionId: "session-1",
      scope: "https://example.org",
      navigationEpoch: 1,
    })

    expect(page.network[0]).toMatchObject({ failure: "net::ERR_ABORTED", durationMs: 10 })
  })

  it("pauses on a same-origin reload, clears old data, and resumes only with a new main document", async () => {
    const harness = started()
    await harness.start()
    const debuggerClient = harness.page.debugger
    debuggerClient.emitMessage("Runtime.executionContextCreated", {
      context: { id: 1, auxData: { isDefault: true, frameId: "MAIN" } },
    })
    debuggerClient.emitMessage("Runtime.consoleAPICalled", {
      executionContextId: 1,
      type: "log",
      timestamp: 2_000,
      args: [{ type: "string", value: "before reload" }],
    })
    debuggerClient.emitMessage("Network.requestWillBeSent", {
      frameId: "MAIN",
      requestId: "old",
      type: "XHR",
      timestamp: 2_000,
      request: { method: "GET", url: "https://example.org/old" },
    })

    harness.inspector.handleNavigationStart(harness.page.id, "https://example.org/page", 2)

    const paused = harness.inspector.readDiagnostics(harness.page, {
      sessionId: "session-1",
      scope: "https://example.org",
      navigationEpoch: 2,
    })
    expect(paused.paused).toBe(true)
    expect(paused.console).toHaveLength(0)
    expect(paused.network).toHaveLength(0)

    // A late response for the old epoch is discarded.
    debuggerClient.emitMessage("Network.loadingFinished", { requestId: "old", timestamp: 2.1 })

    debuggerClient.emitMessage("Page.frameNavigated", { frame: { id: "MAIN", url: "https://example.org/page" } })
    debuggerClient.emitMessage("Runtime.executionContextCreated", {
      context: { id: 9, auxData: { isDefault: true, frameId: "MAIN" } },
    })

    const resumed = harness.inspector.readDiagnostics(harness.page, {
      sessionId: "session-1",
      scope: "https://example.org",
      navigationEpoch: 2,
    })
    expect(resumed.paused).toBe(false)
    expect(resumed.network).toHaveLength(0)
  })

  it("stops immediately on a cross-origin navigation", async () => {
    const harness = started()
    await harness.start()

    harness.inspector.handleNavigationStart(harness.page.id, "https://evil.test/", 2)

    expect(harness.inspector.active).toBe(false)
    expect(harness.page.debugger.attached).toBe(false)
  })

  it("stops if CDP reports a cross-origin main document despite a same-origin start", async () => {
    const harness = started()
    await harness.start()
    harness.inspector.handleNavigationStart(harness.page.id, "https://example.org/next", 2)

    harness.page.debugger.emitMessage("Page.frameNavigated", {
      frame: { id: "MAIN", url: "https://other.example/next" },
    })

    expect(harness.inspector.active).toBe(false)
    expect(harness.page.debugger.attached).toBe(false)
  })

  it("stops when the capture expires", async () => {
    let clock = 1_000
    const harness = started({ now: () => clock })
    await harness.start()
    clock = 1_000 + 60_000

    expect(() =>
      harness.inspector.readDiagnostics(harness.page, {
        sessionId: "session-1",
        scope: "https://example.org",
        navigationEpoch: 1,
      })
    ).toThrow(/expired/)
    expect(harness.inspector.active).toBe(false)
    expect(harness.page.debugger.attached).toBe(false)
  })

  it("detaches at the deadline even when no event or read occurs", async () => {
    vi.useFakeTimers()
    try {
      let clock = 1_000
      const harness = started({ now: () => clock })
      await harness.start()

      clock += 60_000
      await vi.advanceTimersByTimeAsync(60_000)

      expect(harness.inspector.active).toBe(false)
      expect(harness.page.debugger.attached).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("evicts old unfinished requests before their map grows beyond the event limit", async () => {
    const harness = started()
    await harness.start()
    const debuggerClient = harness.page.debugger
    for (let index = 0; index <= 200; index += 1) {
      debuggerClient.emitMessage("Network.requestWillBeSent", {
        frameId: "MAIN",
        requestId: `r${index}`,
        timestamp: 1_000,
        request: { method: "GET", url: `https://example.org/r${index}` },
      })
    }
    debuggerClient.emitMessage("Network.loadingFinished", { requestId: "r0", timestamp: 1_000.1 })
    debuggerClient.emitMessage("Network.loadingFinished", { requestId: "r200", timestamp: 1_000.1 })

    const page = harness.inspector.readDiagnostics(harness.page, {
      sessionId: "session-1",
      scope: "https://example.org",
      navigationEpoch: 1,
    })
    expect(page.network).toEqual([
      { method: "GET", url: "https://example.org/r200", type: "Other", durationMs: 100 },
    ])
    expect(page.truncated).toBe(true)
  })

  it("rejects a second session taking over the capture", async () => {
    const harness = started()
    await harness.start("session-1")

    await expect(harness.start("session-2")).rejects.toThrow(/Another session/)
  })

  it("ignores child debugger sessions and caps the event buffer", async () => {
    const harness = started()
    await harness.start()
    const debuggerClient = harness.page.debugger
    debuggerClient.emitMessage("Runtime.executionContextCreated", {
      context: { id: 1, auxData: { isDefault: true, frameId: "MAIN" } },
    })
    for (let index = 0; index < 250; index += 1) {
      debuggerClient.emitMessage("Runtime.consoleAPICalled", {
        executionContextId: 1,
        type: "log",
        timestamp: 2_000 + index,
        args: [{ type: "string", value: `entry-${index}` }],
      })
    }
    // A child target message must be ignored entirely.
    debuggerClient.emitMessage(
      "Runtime.consoleAPICalled",
      { executionContextId: 1, type: "log", timestamp: 9_000, args: [{ type: "string", value: "child" }] },
      "child-session"
    )

    const page = harness.inspector.readDiagnostics(harness.page, {
      sessionId: "session-1",
      scope: "https://example.org",
      navigationEpoch: 1,
    })

    expect(page.console).toHaveLength(200)
    expect(page.console.at(-1)?.text).toBe("entry-249")
    expect(page.truncated).toBe(true)
  })

  it("stops and detaches on an explicit stop", async () => {
    const harness = started()
    await harness.start()

    const stopped = harness.inspector.stopDiagnostics("requested")

    expect(stopped).toBe(true)
    expect(harness.inspector.active).toBe(false)
    expect(harness.page.debugger.attached).toBe(false)
  })

  it("stops when the guest is destroyed", async () => {
    const harness = started()
    await harness.start()

    harness.page.emit("destroyed")

    expect(harness.inspector.active).toBe(false)
  })
})

describe("sanitizeUrl", () => {
  it("drops credentials, query, and fragment", () => {
    expect(sanitizeUrl("https://user:pass@example.org/p?token=1#frag")).toBe("https://example.org/p")
    expect(sanitizeUrl("not a url?x=1")).toBe("not a url")
    expect(sanitizeUrl(undefined)).toBe("")
  })

  it("does not expose the payload embedded in a data URL", () => {
    expect(sanitizeUrl("data:text/plain,secret-session-token")).toBe("data:[redacted]")
  })
})
