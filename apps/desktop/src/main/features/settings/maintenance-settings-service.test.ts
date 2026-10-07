import { afterEach, describe, expect, it, vi } from "vitest"
import { CURRENT_PROTOCOL_VERSION } from "@vykor/client"
vi.mock("electron", () => ({ app: { getVersion: () => "1.0" }, dialog: {}, shell: {}, Notification: { isSupported: () => false } }))
vi.mock("@vykor/server/daemon-host", () => ({ readDaemonRegistry: () => ({ url: "http://127.0.0.1:7777", token: "secret", storePath: "D:/data/sessions.db" }) }))
vi.mock("../session/session-service", () => ({ desktopSessionService: {} }))
vi.mock("../daemon-autostart/daemon-autostart-service", () => ({ createDesktopDaemonAutoStartController: () => ({ snapshot: async () => ({ enabled: false }) }) }))
vi.mock("./desktop-preferences", () => ({ getDesktopPreferences: () => ({ notificationMode: "always" }) }))
import { MaintenanceSettingsService, redactDiagnosticLog, usageCsv } from "./maintenance-settings-service"
describe("maintenance export boundary", () => {
  afterEach(() => vi.unstubAllGlobals())
  it("keeps only operational fields and never arbitrary content, paths or credentials", () => {
    const log = redactDiagnosticLog({ timestamp: "2026-10-01T10:00:00Z", level: "error", event: "session.run.failed", runId: "run-1", message: "private prompt", error: "Bearer private", path: "D:/private/source", apiKey: "secret", input: "raw tool" })
    expect(log).toMatchObject({ event: "session.run.failed", runId: "run-1" })
    const output = JSON.stringify(log); expect(output).not.toMatch(/private|secret|Bearer|raw tool/)
    expect(redactDiagnosticLog({ event: "D:/secret/path" })).toBeNull()
  })
  it("sends authenticated versioned requests rather than bypassing the wire guard", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ dataDirectory: "D:/data" }), { status: 200 }))
    vi.stubGlobal("fetch", fetch)
    await new MaintenanceSettingsService().storage()
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ headers: { authorization: "Bearer secret", "x-vykor-protocol-version": String(CURRENT_PROTOCOL_VERSION) } })
  })
  it("CSV distinguishes unknown from zero and neutralizes spreadsheet formulas", () => {
    const csv = usageCsv({ requests: [{ id: "r", time: 1, project: "=malicious()", provider: "p", model: "m", sessionId: "s", runId: "r", status: "failed", completeness: "unknown", inputTokens: null, outputTokens: 0, cacheReadTokens: null, cacheCreationTokens: null, cost: null }] } as never)
    expect(csv).toContain("\"'=malicious()\""); expect(csv).toContain('"unknown","","0","",""')
    expect(csv).not.toContain("apiKey")
  })
  it("does not let cleanup from an old page cancel a newer diagnosis", async () => {
    const service = new MaintenanceSettingsService()
    const responses: Record<string, unknown> = {
      "/health": { ok: true, version: "1.0" },
      "/maintenance/readiness": { phase: "ready", accepting: true },
      "/capabilities": { protocol: { version: CURRENT_PROTOCOL_VERSION } },
      "/maintenance/storage/health": { writable: true, availableBytes: 1024 },
      "/auth": { auth: { storedProviders: ["test"] } },
      "/mcp/oauth/status": { servers: [] },
      "/maintenance/environment": { kind: "native", checks: [] },
      "/maintenance/logs": { logs: [] },
      "/maintenance/errors": { errors: [] },
      "/maintenance/restart-preview": { runs: [], tasks: [], terminals: [] },
    }
    vi.spyOn(service, "request").mockImplementation(async (path, _body, signal) => {
      await Promise.resolve()
      if (signal?.aborted) throw signal.reason
      return (responses[path] ?? {}) as never
    })
    const old = service.diagnose({ requestId: "old-page" })
    const current = service.diagnose({ requestId: "current-page" })
    service.cancelDiagnosis({ requestId: "old-page" })
    const [, report] = await Promise.all([old, current])
    expect(report.checks.find((check) => check.id === "health")?.status).toBe("success")
    expect(report.checks.some((check) => check.status === "cancelled")).toBe(false)
  })
})
