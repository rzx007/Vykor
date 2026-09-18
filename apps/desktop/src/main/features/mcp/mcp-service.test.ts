import { describe, expect, it, vi } from "vitest"
import { DesktopMcpService } from "./mcp-service"

const snapshot = {
  servers: [
    {
      name: "linear",
      transport: "http" as const,
      endpoint: "https://mcp.linear.app/mcp",
      authStatus: "not-logged-in",
      scopes: [],
    },
  ],
}

describe("DesktopMcpService", () => {
  it("normalizes scopes and opens the authorization URL through Electron", async () => {
    const openExternal = vi.fn(async () => undefined)
    const application = {
      snapshot: vi.fn(async () => snapshot),
      login: vi.fn(async (input) => {
        await input.openBrowser("https://linear.example/authorize")
        return { servers: [{ ...snapshot.servers[0], authStatus: "valid", scopes: ["read"] }] }
      }),
      logout: vi.fn(async () => snapshot),
    }
    const service = new DesktopMcpService(application as never, openExternal)

    await expect(
      service.login({ name: " linear ", scopes: ["read", " read ", ""] })
    ).resolves.toMatchObject({ servers: [expect.objectContaining({ authStatus: "valid" })] })
    expect(application.login).toHaveBeenCalledWith(
      expect.objectContaining({ name: "linear", scopes: ["read"] })
    )
    expect(openExternal).toHaveBeenCalledWith("https://linear.example/authorize")
  })

  it("returns the updated snapshot after logout", async () => {
    const application = {
      snapshot: vi.fn(async () => snapshot),
      login: vi.fn(),
      logout: vi.fn(async () => snapshot),
    }
    const service = new DesktopMcpService(application as never, vi.fn())
    await expect(service.logout({ name: "linear" })).resolves.toEqual(snapshot)
    expect(application.logout).toHaveBeenCalledWith("linear")
  })

  it("rejects unsafe authorization URLs before Electron opens them", async () => {
    const openExternal = vi.fn(async () => undefined)
    const application = {
      snapshot: vi.fn(async () => snapshot),
      login: vi.fn(async (input) => {
        await input.openBrowser("javascript:alert(1)")
        return snapshot
      }),
      logout: vi.fn(async () => snapshot),
    }
    const service = new DesktopMcpService(application as never, openExternal)
    await expect(service.login({ name: "linear", scopes: ["read"] })).rejects.toThrow(
      "安全的 HTTPS URL"
    )
    expect(openExternal).not.toHaveBeenCalled()
  })

  it("rejects malformed IPC inputs before calling the application", async () => {
    const application = {
      snapshot: vi.fn(async () => snapshot),
      login: vi.fn(),
      logout: vi.fn(),
    }
    const service = new DesktopMcpService(application as never, vi.fn())

    await expect(service.login({ name: "linear", scopes: [1] } as never)).rejects.toThrow(
      "登录参数无效"
    )
    await expect(service.logout(null as never)).rejects.toThrow("退出登录参数无效")
    expect(application.login).not.toHaveBeenCalled()
    expect(application.logout).not.toHaveBeenCalled()
  })
})
