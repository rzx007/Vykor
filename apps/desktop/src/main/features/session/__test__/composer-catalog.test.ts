import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer, type RequestListener } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CURRENT_PROTOCOL_VERSION, HttpTransport } from "@rzx/client"
import log from "electron-log/main"
import { expect, it, vi } from "vitest"
import { DaemonConnectionService } from "../daemon-connection-service"
import { DesktopSessionService } from "../session-service"

it("loads one combined catalog and persists distinct, safe failure stages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vykor-composer-catalog-"))
  const logPath = join(directory, "main.log")
  const originalLogPath = log.transports.file.resolvePathFn
  log.transports.file.resolvePathFn = () => logPath
  const calls: string[] = []
  let stallHandshake = false
  let respond: RequestListener = (_request, response) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({
      commands: [
        { name: "/compact", kind: "session", selection: "execute" },
        { name: "/unhandled", kind: "session" },
      ],
      plugins: [{ pluginId: "plugin", displayName: "Plugin", version: "1.0", scope: "user", origin: "native", description: "Example", capabilities: ["skills"] }],
    }))
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1")
    if (url.pathname === "/capabilities") {
      if (stallHandshake) return
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} }))
      return
    }
    calls.push(url.pathname)
    respond(request, response)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a loopback TCP server")
  const baseUrl = `http://127.0.0.1:${address.port}`
  const connection = new DaemonConnectionService()
  const getTransport = vi.spyOn(connection, "getTransport")
  const transport = new HttpTransport({ baseUrl, token: "private-test-token" })
  const cwd = join(directory, "private-test-cwd")
  const service = new DesktopSessionService(connection)
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal)
  try {
    getTransport.mockResolvedValue(transport)
    await expect(service.getComposerCatalog(cwd)).resolves.toMatchObject({
      commands: [{ name: "/compact" }], plugins: [{ pluginId: "plugin" }],
    })
    expect(calls).toEqual(["/context/composer-catalog"])

    getTransport.mockRejectedValueOnce(new DOMException("private-test-connection", "TimeoutError"))
    await expect(service.getComposerCatalog(cwd)).rejects.toThrow(/超时/)
    stallHandshake = true
    getTransport.mockResolvedValueOnce(new HttpTransport({ baseUrl, handshakeTimeoutMs: 100 }))
    await expect(service.getComposerCatalog(cwd)).rejects.toThrow(/连接后台超时/)
    stallHandshake = false
    expect(calls).toHaveLength(1)

    respond = (request) => request.socket.destroy()
    await expect(service.getComposerCatalog(cwd)).rejects.toThrow(/读取/)

    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(100))
    respond = (_request, response) => {
      response.setHeader("content-type", "application/json")
      response.flushHeaders()
      response.write("{")
    }
    try {
      await expect(service.getComposerCatalog(cwd)).rejects.toThrow(/超时/)
    } finally {
      timeout.mockRestore()
    }

    respond = (_request, response) => response.end("private-test-malformed-json")
    await expect(service.getComposerCatalog(cwd)).rejects.toThrow(/格式/)
    respond = (_request, response) => response.end(JSON.stringify({ commands: [], plugins: [null] }))
    await expect(service.getComposerCatalog(cwd)).rejects.toThrow(/格式/)

    const entries = await readFile(logPath, "utf8")
    expect(entries).not.toMatch(/private-test|http:\/\/127\.0\.0\.1/)
    const records = entries.trim().split(/\r?\n/).map(line => JSON.parse(line.slice(line.indexOf("{"))))
    expect(records).toEqual([
      { interface: "GET /context/composer-catalog", stage: "connect", code: "daemon_connection_timeout" },
      { interface: "GET /context/composer-catalog", stage: "connect", code: "daemon_connection_timeout" },
      { interface: "GET /context/composer-catalog", stage: "forward", code: "daemon_request_failed" },
      { interface: "GET /context/composer-catalog", stage: "response", code: "daemon_response_timeout" },
      { interface: "GET /context/composer-catalog", stage: "decode", code: "daemon_invalid_response" },
      { interface: "GET /context/composer-catalog", stage: "decode", code: "daemon_invalid_response" },
    ])
  } finally {
    log.transports.file.resolvePathFn = originalLogPath
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
