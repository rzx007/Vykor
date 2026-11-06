import { EventEmitter, once } from "node:events"
import { createServer, type ServerResponse } from "node:http"
import { CURRENT_PROTOCOL_VERSION } from "@vykor/application-client"
import { afterEach, expect, it, vi } from "vitest"

const electron = vi.hoisted(() => ({ fromId: vi.fn() }))
vi.mock("electron", () => ({ webContents: electron }))

import { BrowserAgentService } from "../browser-agent-service"
import { startBrowserBridge } from "../browser-bridge"

const browserObservation = {
  url: "https://example.org/",
  title: "Fixture",
  pageText: "Page text",
  elements: [],
}
const command = {
  type: "command",
  kind: "browser",
  action: { action: "inspect" },
  includeScreenshot: true,
  cwd: "D:/workspace",
  sessionId: "session-1",
}

function createBrowser() {
  let debuggerAttached = false
  const debuggerClient = Object.assign(new EventEmitter(), {
    isAttached: () => debuggerAttached,
    attach: () => {
      debuggerAttached = true
    },
    detach: () => {
      debuggerAttached = false
    },
    sendCommand: async (method: string) =>
      method === "Page.getFrameTree" ? { frameTree: { frame: { id: "main" } } } : {},
  })
  const page = Object.assign(new EventEmitter(), {
    id: 7,
    debugger: debuggerClient,
    getURL: () => "https://example.org/",
    isDestroyed: () => false,
    loadURL: vi.fn(async (_url: string) => {}),
    stop: vi.fn(),
    executeJavaScript: vi.fn(async () => browserObservation),
    capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from("PNG") })),
  })
  electron.fromId.mockReturnValue(page)
  const browser = new BrowserAgentService({ isDeveloperModeEnabled: () => true })
  browser.trackGuest(42, page as never)
  browser.bindTab(42, "tab", page.id)
  browser.setActiveTab(42, "tab")
  return { browser, page }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

async function createDaemon(holdApproval = false, cancelledResultId?: string) {
  const requests: Array<{ path: string; body: unknown }> = []
  const closedApprovals: string[] = []
  const streams: ServerResponse[] = []
  const server = createServer(async (request, response) => {
    if (request.url === "/capabilities") {
      response.end(
        JSON.stringify({
          serverVersion: "test",
          protocol: { version: CURRENT_PROTOCOL_VERSION },
          features: {},
        })
      )
      return
    }
    if (
      request.headers.authorization !== "Bearer registry-token" ||
      Object.keys(request.headers).some(
        (header) => header.startsWith("sec-fetch-") || header === "origin"
      )
    ) {
      response.writeHead(403).end()
      return
    }
    if (request.url === "/browser-host/stream") {
      response.writeHead(200, { "content-type": "text/event-stream" })
      streams.push(response)
      send(response, { type: "hello", connectionId: "connection-" + streams.length })
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({ path: request.url!, body: JSON.parse(Buffer.concat(chunks).toString()) })
    if (cancelledResultId && request.url?.endsWith(`/${cancelledResultId}/result`)) {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "Browser request is no longer pending." }))
      return
    }
    if (holdApproval && request.url?.endsWith("/approval")) {
      response.once("close", () => closedApprovals.push(request.url!))
      return
    }
    response.end(
      JSON.stringify(request.url?.endsWith("/approval") ? { approved: true } : { ok: true })
    )
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
  )
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected TCP listener.")
  return { baseUrl: "http://127.0.0.1:" + address.port, requests, streams, closedApprovals }
}

function send(response: ServerResponse, event: object) {
  response.write("data: " + JSON.stringify(event) + "\n\n")
}

it("posts approval and the screenshot result under the stream connection and command IDs", async () => {
  const { browser } = createBrowser()
  const daemon = await createDaemon()
  const token = {}
  cleanups.push(
    startBrowserBridge({
      browser,
      baseUrl: daemon.baseUrl,
      token: "registry-token",
      getOwnerSessionToken: (owner, session) =>
        owner === 42 && session === "session-1" ? token : undefined,
    })
  )
  await vi.waitFor(() => expect(daemon.streams).toHaveLength(1))
  send(daemon.streams[0]!, { ...command, requestId: "request-1", deadlineAt: Date.now() + 5_000 })

  await vi.waitFor(() =>
    expect(daemon.requests).toEqual([
      {
        path: "/browser-host/connection-1/request-1/approval",
        body: { kind: "origin", reason: expect.stringContaining("https://example.org") },
      },
      {
        path: "/browser-host/connection-1/request-1/result",
        body: { result: { ...browserObservation, annotations: [] }, screenshotBase64: "UE5H" },
      },
    ])
  )
})

it("aborts an approval when the stream closes and does not replay the command on reconnect", async () => {
  const { browser, page } = createBrowser()
  const daemon = await createDaemon(true)
  const token = {}
  cleanups.push(
    startBrowserBridge({
      browser,
      baseUrl: daemon.baseUrl,
      token: "registry-token",
      getOwnerSessionToken: () => token,
    })
  )
  await vi.waitFor(() => expect(daemon.streams).toHaveLength(1))
  send(daemon.streams[0]!, { ...command, requestId: "request-1", deadlineAt: Date.now() + 5_000 })
  await vi.waitFor(() => expect(daemon.requests).toHaveLength(1))
  daemon.streams[0]!.end()

  await vi.waitFor(() =>
    expect(daemon.closedApprovals).toEqual(["/browser-host/connection-1/request-1/approval"])
  )
  await vi.waitFor(() => expect(daemon.streams).toHaveLength(2), { timeout: 3_000 })
  expect(daemon.requests).toHaveLength(1)
  expect(page.capturePage).not.toHaveBeenCalled()
  expect(browser.listOriginApprovals()).toEqual([])
})

it("receives cancellation while the approval POST is still pending", async () => {
  const { browser, page } = createBrowser()
  const daemon = await createDaemon(true)
  const token = {}
  cleanups.push(
    startBrowserBridge({
      browser,
      baseUrl: daemon.baseUrl,
      token: "registry-token",
      getOwnerSessionToken: () => token,
    })
  )
  await vi.waitFor(() => expect(daemon.streams).toHaveLength(1))
  const stream = daemon.streams[0]!
  send(stream, { ...command, requestId: "request-1", deadlineAt: Date.now() + 5_000 })
  await vi.waitFor(() => expect(daemon.requests).toHaveLength(1))
  send(stream, { type: "cancel", requestId: "request-1" })
  send(stream, { ...command, requestId: "request-2", deadlineAt: Date.now() + 5_000 })

  await vi.waitFor(() => {
    expect(daemon.closedApprovals).toEqual(["/browser-host/connection-1/request-1/approval"])
    expect(daemon.requests.map(({ path }) => path)).toEqual([
      "/browser-host/connection-1/request-1/approval",
      "/browser-host/connection-1/request-2/approval",
    ])
  })
  expect(daemon.streams).toHaveLength(1)
  expect(page.capturePage).not.toHaveBeenCalled()
})

it("keeps the stream open when a result arrives after the daemon cancelled its request", async () => {
  const { browser } = createBrowser()
  const daemon = await createDaemon(false, "cancelled")
  const token = {}
  cleanups.push(startBrowserBridge({
    browser,
    baseUrl: daemon.baseUrl,
    token: "registry-token",
    getOwnerSessionToken: () => token,
  }))
  await vi.waitFor(() => expect(daemon.streams).toHaveLength(1))
  const stream = daemon.streams[0]!
  const deadlineAt = Date.now() + 5_000
  send(stream, { ...command, requestId: "cancelled", deadlineAt })
  await vi.waitFor(() => expect(daemon.requests.map(({ path }) => path)).toContain(
    "/browser-host/connection-1/cancelled/result"
  ))

  send(stream, { ...command, requestId: "next", deadlineAt })
  await vi.waitFor(() => expect(daemon.requests.map(({ path }) => path)).toContain(
    "/browser-host/connection-1/next/result"
  ))
  expect(stream.destroyed).toBe(false)
})

it("lets the next command run after cancelling an inspection waiting on Electron", async () => {
  const { browser, page } = createBrowser()
  const daemon = await createDaemon()
  const token = {}
  const inspection = Promise.withResolvers<typeof browserObservation>()
  const started = Promise.withResolvers<void>()
  page.executeJavaScript.mockImplementationOnce(() => {
    started.resolve()
    return inspection.promise
  })
  cleanups.push(startBrowserBridge({
    browser,
    baseUrl: daemon.baseUrl,
    token: "registry-token",
    getOwnerSessionToken: () => token,
  }))
  await vi.waitFor(() => expect(daemon.streams).toHaveLength(1))
  const stream = daemon.streams[0]!
  const deadlineAt = Date.now() + 5_000
  send(stream, { ...command, requestId: "cancelled", deadlineAt })
  await started.promise

  try {
    send(stream, { type: "cancel", requestId: "cancelled" })
    send(stream, { ...command, requestId: "next", deadlineAt })
    await vi.waitFor(() => expect(daemon.requests.map(({ path }) => path)).toEqual([
      "/browser-host/connection-1/cancelled/approval",
      "/browser-host/connection-1/next/result",
    ]))
  } finally {
    inspection.resolve(browserObservation)
  }
})

it("stops an in-flight navigation on disconnect so new browser commands can run", async () => {
  const { browser, page } = createBrowser()
  const daemon = await createDaemon()
  const token = {}
  const navigation = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  page.loadURL.mockImplementation(() => {
    started.resolve()
    return navigation.promise
  })
  page.stop.mockImplementation(() => navigation.reject(new Error("Navigation cancelled")))
  cleanups.push(
    startBrowserBridge({
      browser,
      baseUrl: daemon.baseUrl,
      token: "registry-token",
      getOwnerSessionToken: () => token,
    })
  )
  await vi.waitFor(() => expect(daemon.streams).toHaveLength(1))
  send(daemon.streams[0]!, {
    ...command,
    action: { action: "navigate", url: browserObservation.url },
    requestId: "navigate",
    deadlineAt: Date.now() + 5_000,
  })
  await started.promise
  daemon.streams[0]!.end()

  await vi.waitFor(() => expect(daemon.streams).toHaveLength(2), { timeout: 3_000 })
  send(daemon.streams[1]!, { ...command, requestId: "inspect", deadlineAt: Date.now() + 5_000 })
  await vi.waitFor(() =>
    expect(daemon.requests.map(({ path }) => path)).toEqual([
      "/browser-host/connection-1/navigate/approval",
      "/browser-host/connection-2/inspect/result",
    ])
  )
})

it("forwards both developer approvals and detaches diagnostics when the stream closes", async () => {
  const { browser, page } = createBrowser()
  const daemon = await createDaemon()
  const token = {}
  cleanups.push(
    startBrowserBridge({
      browser,
      baseUrl: daemon.baseUrl,
      token: "registry-token",
      getOwnerSessionToken: () => token,
    })
  )
  await vi.waitFor(() => expect(daemon.streams).toHaveLength(1))
  send(daemon.streams[0]!, {
    type: "command",
    kind: "developer",
    action: { action: "start_diagnostics" },
    cwd: "D:/workspace",
    sessionId: "session-1",
    requestId: "diagnostics",
    deadlineAt: Date.now() + 5_000,
  })
  const requestPath = "/browser-host/connection-1/diagnostics"
  await vi.waitFor(() =>
    expect(daemon.requests).toEqual([
      { path: requestPath + "/approval", body: { kind: "origin", reason: expect.any(String) } },
      { path: requestPath + "/approval", body: { kind: "developer", reason: expect.any(String) } },
      {
        path: requestPath + "/result",
        body: {
          result: {
            action: "start_diagnostics",
            url: "https://example.org/",
            data: { startedAt: expect.any(Number), expiresAt: expect.any(Number) },
          },
        },
      },
    ])
  )
  expect(page.debugger.isAttached()).toBe(true)
  daemon.streams[0]!.end()

  await vi.waitFor(() => expect(page.debugger.isAttached()).toBe(false))
})
