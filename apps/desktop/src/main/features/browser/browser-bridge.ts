import { request } from "node:http"
import { Readable } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"
import { HttpTransport, SseTransport, VykorApiError } from "@vykor/application-client"
import {
  BROWSER_BRIDGE_MAX_RESULT_BODY_BYTES,
  BROWSER_BRIDGE_RESULT_TOO_LARGE,
  parseBrowserBridgeEvent,
  type BrowserBridgeEvent,
} from "@vykor/server/daemon-host"
import { isLoopbackDaemonUrl } from "../daemon-autostart/daemon-surface"
import {
  browserAgentService,
  type BrowserAgentService,
  type BrowserRequestScope,
} from "./browser-agent-service"

interface BrowserBridgeOptions {
  baseUrl: string
  token: string
  getOwnerSessionToken: BrowserRequestScope["getOwnerSessionToken"]
  browser?: BrowserAgentService
}

const streamPath = "/browser-host/stream"

// Global fetch sends Sec-Fetch-Mode even in Node. The private route accepts only
// native clients without browser headers. node:http also refuses redirects.
const browserBridgeFetch: typeof fetch = (url, options) =>
  new Promise<Response>((resolve, reject) => {
    const client = request(
      String(url),
      {
        method: options?.method,
        headers: Object.fromEntries(new Headers(options?.headers)),
        signal: options?.signal ?? undefined,
      },
      (incoming) => {
        const headers = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(", ") : value)
        }
        const status = incoming.statusCode ?? 500
        const hasBody = status !== 204 && status !== 205 && status !== 304
        if (!hasBody) incoming.resume()
        resolve(
          new Response(hasBody ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>) : null, {
            status,
            headers,
          })
        )
      }
    )
    client.once("error", reject)
    client.end(options?.body as string | undefined)
  })

export function startBrowserBridge(options: BrowserBridgeOptions): () => void {
  const url = new URL(options.baseUrl)
  if (url.protocol !== "http:" || !isLoopbackDaemonUrl(options.baseUrl)) {
    throw new Error("The browser bridge requires a local daemon address.")
  }
  const browser = options.browser ?? browserAgentService
  const http = new HttpTransport({
    baseUrl: options.baseUrl,
    token: options.token,
    fetch: browserBridgeFetch,
  })
  const sse = new SseTransport(http)
  const shutdown = new AbortController()

  async function runCommand(
    command: Extract<BrowserBridgeEvent, { type: "command" }>,
    connectionId: string,
    signal: AbortSignal
  ): Promise<void> {
    const path =
      "/browser-host/" +
      encodeURIComponent(connectionId) +
      "/" +
      encodeURIComponent(command.requestId)
    const approve = async (kind: "origin" | "developer", reason: string): Promise<boolean> => {
      const response = await http.request<{ approved: boolean }>(path + "/approval", {
        method: "POST",
        body: { kind, reason },
        signal,
      })
      return response.approved === true
    }
    const scope = { getOwnerSessionToken: options.getOwnerSessionToken, signal }
    const { sessionId, cwd } = command
    let body: object
    try {
      signal.throwIfAborted()
      if (command.kind === "browser") {
        const { screenshotBytes, ...result } = await browser.execute(
          {
            action: command.action,
            sessionId,
            cwd,
            includeScreenshot: command.includeScreenshot,
            approve: (reason) => approve("origin", reason),
          },
          scope
        )
        body = {
          result,
          ...(screenshotBytes
            ? { screenshotBase64: Buffer.from(screenshotBytes).toString("base64") }
            : {}),
        }
      } else {
        body = {
          result: await browser.executeDeveloper(
            {
              action: command.action,
              sessionId,
              cwd,
              approveOrigin: (reason) => approve("origin", reason),
              approveDeveloper: (reason) => approve("developer", reason),
            },
            scope
          ),
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      body = { error: message.slice(0, 4_096) || "Browser operation failed." }
    }
    signal.throwIfAborted()
    let payload = JSON.stringify(body)
    // The server can close the upload before an oversized POST receives its 413.
    if (Buffer.byteLength(payload) > BROWSER_BRIDGE_MAX_RESULT_BODY_BYTES) {
      payload = JSON.stringify({ error: BROWSER_BRIDGE_RESULT_TOO_LARGE })
    }
    try {
      const response = await http.requestResponse(path + "/result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        signal,
      })
      await response.json()
    } catch (error) {
      // A retired request (404) or an oversized result (413) is already settled by the daemon.
      if (!(error instanceof VykorApiError && (error.status === 404 || error.status === 413)))
        throw error
    }
  }

  async function connect(): Promise<void> {
    const connection = new AbortController()
    const signal = AbortSignal.any([shutdown.signal, connection.signal])
    const requests = new Map<string, AbortController>()
    let connectionId: string | undefined
    const stopDiagnostics = (): void => {
      browser.stopDeveloperDiagnostics()
    }
    try {
      const stream = sse.stream(http.resolveUrl(streamPath), {
        decode: parseBrowserBridgeEvent,
        signal,
        idleTimeoutMs: 45_000,
      })
      for await (const event of stream) {
        signal.throwIfAborted()
        if (event.type === "hello" && connectionId === undefined) {
          connectionId = event.connectionId
          signal.addEventListener("abort", stopDiagnostics, { once: true })
        } else if (!connectionId || event.type === "hello") {
          throw new Error("Unexpected browser bridge event.")
        } else if (event.type === "cancel") {
          requests.get(event.requestId)?.abort()
        } else if (!requests.has(event.requestId)) {
          const remaining = event.deadlineAt - Date.now()
          if (remaining <= 0) continue
          const request = new AbortController()
          const requestSignal = AbortSignal.any([
            signal,
            request.signal,
            AbortSignal.timeout(Math.min(remaining, 2_147_483_647)),
          ])
          requests.set(event.requestId, request)
          // Approval and result POSTs run beside the stream so it can receive cancel immediately.
          void runCommand(event, connectionId, requestSignal)
            .catch(() => {
              // A lost result can follow a completed action. Close the stream so the
              // daemon reports an unknown outcome, and let it issue only new commands.
              if (!requestSignal.aborted) connection.abort()
            })
            .finally(() => requests.delete(event.requestId))
        }
      }
    } finally {
      connection.abort()
    }
  }

  async function run(): Promise<void> {
    while (!shutdown.signal.aborted) {
      // Each connection starts without an event cursor or any pending commands.
      await connect().catch(() => undefined)
      if (!shutdown.signal.aborted) {
        await delay(1_000, undefined, { signal: shutdown.signal, ref: false }).catch(
          () => undefined
        )
      }
    }
  }

  void run()
  return () => shutdown.abort()
}
