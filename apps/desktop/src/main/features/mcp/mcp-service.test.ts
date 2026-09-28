import { describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import type { McpServerSummary } from "@vykor/server"
import { DesktopMcpService } from "./mcp-service"

function summary(overrides: Partial<McpServerSummary> = {}): McpServerSummary {
  return {
    name: "linear",
    enabled: true,
    transport: "http",
    summary: "https://mcp.linear.app/mcp",
    authMode: "oauth",
    authStatus: "not-logged-in",
    scopes: [],
    runtimeStatus: "connected",
    ...overrides,
  }
}

function createService() {
  const config = {
    list: vi.fn(async () => ({ servers: [summary()] })),
    getConfig: vi.fn(async () => ({ type: "http", url: "https://mcp.linear.app/mcp" })),
    exportConfig: vi.fn(async () => ({
      mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
    })),
    add: vi.fn(async () => ({ persisted: true, credentialRemoved: false, runtimeFailures: [] })),
    update: vi.fn(async () => ({ persisted: true, credentialRemoved: false, runtimeFailures: [] })),
    remove: vi.fn(async () => ({ persisted: true, credentialRemoved: true, runtimeFailures: [] })),
    setEnabled: vi.fn(async () => ({ persisted: true, credentialRemoved: false, runtimeFailures: [] })),
  }
  const openExternal = vi.fn(async () => undefined)
  const client = {
    protocol: { capabilities: vi.fn(async () => ({ features: { mcpOAuth: 1 }, mcpOAuth: { instanceId: "instance-1" } })) },
    mcp: {
      startLogin: vi.fn(async () => ({ loginId: "login-1", operation: { loginId: "login-1", name: "linear", state: "pending" as const, credentialCommitted: false, authorizationReady: true, authorizationUrl: "https://linear.example/authorize" } })),
      getLogin: vi.fn(async () => ({ loginId: "login-1", name: "linear", state: "pending" as const, credentialCommitted: false, authorizationReady: true, authorizationUrl: "https://linear.example/authorize" })),
      watchLogin: vi.fn(async function* () { yield { event: "mcp.oauth.login.completed", data: { loginId: "login-1", name: "linear", state: "completed", credentialCommitted: true, authorizationReady: true } }; }),
      cancelLogin: vi.fn(async () => ({ loginId: "login-1", name: "linear", state: "cancelled" as const, credentialCommitted: false, authorizationReady: true })),
      logout: vi.fn(async () => ({ servers: [] })),
      authStatus: vi.fn(async () => ({ servers: [] })),
    },
  }
  const service = new DesktopMcpService({
    config: config as never,
    openExternal,
    daemonClient: async () => client as never,
  })
  return { service, config, openExternal, client }
}

describe("DesktopMcpService", () => {
  it("starts through the connected daemon, opens the URL once and returns only safe state", async () => {
    const { service, openExternal } = createService()
    const operation = { loginId: "login-1", name: "linear", state: "pending", credentialCommitted: false, authorizationReady: true, authorizationUrl: "https://auth.example/authorize?state=private" }
    const client = {
      protocol: { capabilities: vi.fn(async () => ({ features: { mcpOAuth: 1 }, mcpOAuth: { instanceId: "instance-1" } })) },
      mcp: {
        startLogin: vi.fn(async () => ({ loginId: "login-1", operation })),
        getLogin: vi.fn(async () => operation),
        watchLogin: vi.fn(async function* () { yield { event: "mcp.oauth.login.updated", data: operation }; }),
        cancelLogin: vi.fn(async () => ({ ...operation, state: "cancelled" })),
        logout: vi.fn(async () => ({ servers: [] })),
        authStatus: vi.fn(async () => ({ servers: [] })),
      },
    }
    const connected = vi.fn(async () => client)
    const daemonService = new DesktopMcpService({
      config: (service as never)["config"],
      openExternal,
      daemonClient: connected,
    } as never)
    const result = await daemonService.login({ name: "linear", scopes: [] })
    await Promise.resolve()
    expect(connected).toHaveBeenCalledTimes(1)
    expect(client.mcp.startLogin).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain("auth.example")
    expect(JSON.stringify(result)).not.toContain("private")
  })

  it("does not leak an authorization URL when the OS refuses to open it", async () => {
    const { config, client } = createService()
    const openExternal = vi.fn(async (url: string) => { throw new Error(`Failed to open ${url}`) })
    const service = new DesktopMcpService({ config: config as never, daemonClient: async () => client as never, openExternal })
    const error = await service.login({ name: "linear", scopes: [] }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("无法打开 OAuth 授权页面")
    expect((error as Error).message).not.toContain("linear.example")
  })

  it("does not create or open an operation after its window has closed", async () => {
    const { config, client, openExternal } = createService()
    const service = new DesktopMcpService({ config: config as never, daemonClient: async () => client as never, openExternal })
    const owner = { isDestroyed: () => true } as never
    await expect(service.login({ name: "linear", scopes: [] }, owner)).rejects.toThrow("窗口已关闭")
    expect(client.mcp.startLogin).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it("opens the authorization URL once when SSE and status race for details", async () => {
    const { config, client, openExternal } = createService()
    let release!: (value: unknown) => void
    const detail = new Promise<unknown>((resolve) => { release = resolve })
    client.mcp.startLogin.mockResolvedValueOnce({ loginId: "login-1", operation: { loginId: "login-1", name: "linear", state: "pending", credentialCommitted: false, authorizationReady: true } } as never)
    client.mcp.getLogin.mockImplementation(async () => await detail as never)
    client.mcp.watchLogin.mockImplementationOnce(async function* () { yield { event: "mcp.oauth.login.updated", data: { loginId: "login-1", name: "linear", state: "pending", credentialCommitted: false, authorizationReady: true } }; })
    const service = new DesktopMcpService({ config: config as never, daemonClient: async () => client as never, openExternal })
    const started = service.login({ name: "linear", scopes: [] })
    await vi.waitFor(() => expect(client.mcp.getLogin).toHaveBeenCalledTimes(1))
    const status = service.loginStatus({ loginId: "login-1" })
    release({ loginId: "login-1", name: "linear", state: "pending", credentialCommitted: false, authorizationReady: true, authorizationUrl: "https://linear.example/authorize?state=private" })
    await Promise.all([started, status])
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  it("drops the local UI subscription when its window closes without cancelling daemon login", async () => {
    const { config, client, openExternal } = createService()
    client.mcp.watchLogin.mockImplementationOnce(async function* () { await new Promise<void>(() => undefined) })
    const owner = new EventEmitter() as EventEmitter & { isDestroyed(): boolean }
    let destroyed = false
    owner.isDestroyed = () => destroyed
    const service = new DesktopMcpService({ config: config as never, daemonClient: async () => client as never, openExternal })
    await service.login({ name: "linear", scopes: [] }, owner as never)
    destroyed = true
    owner.emit("destroyed")
    await expect(service.loginStatus({ loginId: "login-1" })).rejects.toThrow("已过期")
    expect(client.mcp.cancelLogin).not.toHaveBeenCalled()
  })
  it("returns a secret-free snapshot with enabled and safe summary", async () => {
    const { service } = createService()

    await expect(service.snapshot()).resolves.toEqual({
      servers: [
        {
          name: "linear",
          enabled: true,
          transport: "http",
          summary: "https://mcp.linear.app/mcp",
          authMode: "oauth",
          authStatus: "not-logged-in",
          scopes: [],
          runtimeStatus: "connected",
        },
      ],
    })
  })

  it("returns the full config only for getConfig and exports only mcpServers", async () => {
    const { service, config } = createService()

    await expect(service.getConfig({ name: "linear" })).resolves.toEqual({
      type: "http",
      url: "https://mcp.linear.app/mcp",
    })
    await expect(service.exportConfig()).resolves.toEqual({
      mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
    })
    expect(config.getConfig).toHaveBeenCalledWith("linear")
  })

  it("routes add, update, remove and setEnabled through the config application service", async () => {
    const { service, config } = createService()

    await service.add({ name: "beui", config: { type: "stdio", command: "npx" } })
    await service.update({
      name: "linear",
      config: { type: "http", url: "https://mcp.linear.app/v2" },
      expectedConfig: { type: "http", url: "https://mcp.linear.app/mcp" },
    })
    await service.remove({ name: "linear" })
    await service.setEnabled({ name: "linear", enabled: false })

    expect(config.add).toHaveBeenCalledWith({ name: "beui", config: { type: "stdio", command: "npx" } })
    expect(config.update).toHaveBeenCalledWith({
      name: "linear",
      config: { type: "http", url: "https://mcp.linear.app/v2" },
      expectedConfig: { type: "http", url: "https://mcp.linear.app/mcp" },
    })
    expect(config.remove).toHaveBeenCalledWith("linear")
    expect(config.setEnabled).toHaveBeenCalledWith({ name: "linear", enabled: false })
  })

  it("keeps persisted true and attaches runtime failures for a saved-but-not-synced operation", async () => {
    const { service, config } = createService()
    config.setEnabled.mockResolvedValueOnce({
      persisted: true,
      credentialRemoved: false,
      runtimeFailures: [{ runtimeId: "runtime-1", message: "reconnect failed" }],
    } as never)

    const result = await service.setEnabled({ name: "linear", enabled: true })

    expect(result.persisted).toBe(true)
    expect(result.runtimeFailures).toEqual([{ runtimeId: "runtime-1", message: "reconnect failed" }])
    expect(result.snapshot.servers).toHaveLength(1)
  })

  it("normalizes scopes, opens the authorization URL, and returns safe operation state", async () => {
    const { service, client, openExternal } = createService()

    await expect(
      service.login({ name: " linear ", scopes: ["read", " read ", ""] })
    ).resolves.toMatchObject({ loginId: "login-1", name: "linear", state: "pending" })
    expect(client.mcp.startLogin).toHaveBeenCalledWith(
      "linear", expect.objectContaining({ scopes: ["read"] })
    )
    expect(openExternal).toHaveBeenCalledWith("https://linear.example/authorize")
  })

  it("returns the updated snapshot after logout", async () => {
    const { service, client } = createService()
    await expect(service.logout({ name: "linear" })).resolves.toMatchObject({
      servers: [expect.objectContaining({ name: "linear" })],
    })
    expect(client.mcp.logout).toHaveBeenCalledWith("linear")
  })

  it("rejects unsafe authorization URLs before Electron opens them", async () => {
    const { service, openExternal, client } = createService()
    client.mcp.startLogin.mockResolvedValueOnce({ loginId: "login-1", operation: { loginId: "login-1", name: "linear", state: "pending", credentialCommitted: false, authorizationReady: true, authorizationUrl: "javascript:alert(1)" } } as never)

    await expect(service.login({ name: "linear", scopes: [] })).rejects.toThrow("安全的 HTTPS URL")
    expect(openExternal).not.toHaveBeenCalled()
  })

  it("rejects malformed IPC inputs before calling the application", async () => {
    const { service, config } = createService()

    await expect(service.login({ name: "linear", scopes: [1] } as never)).rejects.toThrow(
      "登录参数无效"
    )
    await expect(service.logout(null as never)).rejects.toThrow("退出登录参数无效")
    await expect(service.add({ name: "  ", config: {} } as never)).rejects.toThrow("添加参数无效")
    await expect(service.setEnabled({ name: "linear", enabled: "yes" } as never)).rejects.toThrow(
      "启停参数无效"
    )
    expect(config.add).not.toHaveBeenCalled()
  })
})
