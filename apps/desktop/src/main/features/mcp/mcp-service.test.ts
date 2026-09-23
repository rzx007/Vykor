import { describe, expect, it, vi } from "vitest"
import type { McpServerSummary } from "@openharness/server"
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
  const oauth = {
    login: vi.fn(async (input: { openBrowser: (url: string) => Promise<void> }) => {
      await input.openBrowser("https://linear.example/authorize")
      return { servers: [] }
    }),
    logout: vi.fn(async () => ({ servers: [] })),
  }
  const openExternal = vi.fn(async () => undefined)
  const service = new DesktopMcpService({
    config: config as never,
    oauth: oauth as never,
    openExternal,
  })
  return { service, config, oauth, openExternal }
}

describe("DesktopMcpService", () => {
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

  it("normalizes scopes, opens the authorization URL, and returns a fresh snapshot", async () => {
    const { service, oauth, openExternal } = createService()

    await expect(
      service.login({ name: " linear ", scopes: ["read", " read ", ""] })
    ).resolves.toMatchObject({ servers: [expect.objectContaining({ name: "linear" })] })
    expect(oauth.login).toHaveBeenCalledWith(
      expect.objectContaining({ name: "linear", scopes: ["read"] })
    )
    expect(openExternal).toHaveBeenCalledWith("https://linear.example/authorize")
  })

  it("returns the updated snapshot after logout", async () => {
    const { service, oauth } = createService()
    await expect(service.logout({ name: "linear" })).resolves.toMatchObject({
      servers: [expect.objectContaining({ name: "linear" })],
    })
    expect(oauth.logout).toHaveBeenCalledWith("linear")
  })

  it("rejects unsafe authorization URLs before Electron opens them", async () => {
    const { service, openExternal, oauth } = createService()
    oauth.login.mockImplementationOnce(async (input: { openBrowser: (url: string) => Promise<void> }) => {
      await input.openBrowser("javascript:alert(1)")
      return { servers: [] }
    })

    await expect(service.login({ name: "linear", scopes: [] })).rejects.toThrow("安全的 HTTPS URL")
    expect(openExternal).not.toHaveBeenCalled()
  })

  it("rejects malformed IPC inputs before calling the application", async () => {
    const { service, config, oauth } = createService()

    await expect(service.login({ name: "linear", scopes: [1] } as never)).rejects.toThrow(
      "登录参数无效"
    )
    await expect(service.logout(null as never)).rejects.toThrow("退出登录参数无效")
    await expect(service.add({ name: "  ", config: {} } as never)).rejects.toThrow("添加参数无效")
    await expect(service.setEnabled({ name: "linear", enabled: "yes" } as never)).rejects.toThrow(
      "启停参数无效"
    )
    expect(config.add).not.toHaveBeenCalled()
    expect(oauth.login).not.toHaveBeenCalled()
  })
})
