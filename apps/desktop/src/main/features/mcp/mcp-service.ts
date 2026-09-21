import { shell } from "electron"
import { McpOAuthApplicationService, type McpOAuthSnapshot } from "@openharness/server"
import type {
  DesktopMcpLoginInput,
  DesktopMcpSnapshot,
  DesktopMcpLogoutInput,
} from "@shared/mcp-types"
import { createDesktopMcpRuntimeCoordinator } from "./mcp-runtime-coordinator"

type McpApplication = Pick<McpOAuthApplicationService, "snapshot" | "login" | "logout">

export class DesktopMcpService {
  constructor(
    private readonly application: McpApplication = new McpOAuthApplicationService({
      coordinator: createDesktopMcpRuntimeCoordinator(),
    }),
    private readonly openExternal = (url: string): Promise<void> => shell.openExternal(url)
  ) { }

  async snapshot(): Promise<DesktopMcpSnapshot> {
    return toDesktopSnapshot(await this.application.snapshot())
  }

  async login(input: DesktopMcpLoginInput): Promise<DesktopMcpSnapshot> {
    assertLoginInput(input)
    const name = input.name.trim()
    const scopes = [...new Set(input.scopes.map((scope) => scope.trim()).filter(Boolean))]
    if (!name) throw new Error("请选择 MCP 服务。")
    return toDesktopSnapshot(
      await this.application.login({
        name,
        scopes,
        openBrowser: (url) => this.openAuthorizationUrl(url),
      })
    )
  }

  async logout(input: DesktopMcpLogoutInput): Promise<DesktopMcpSnapshot> {
    assertLogoutInput(input)
    const name = input.name.trim()
    if (!name) throw new Error("请选择 MCP 服务。")
    return toDesktopSnapshot(await this.application.logout(name))
  }

  private async openAuthorizationUrl(value: string): Promise<void> {
    const target = new URL(value)
    if (target.protocol !== "https:" || target.username || target.password || target.hash) {
      throw new Error("OAuth 授权地址必须是安全的 HTTPS URL。")
    }
    await this.openExternal(target.href)
  }
}

export const desktopMcpService = new DesktopMcpService()

function toDesktopSnapshot(snapshot: McpOAuthSnapshot): DesktopMcpSnapshot {
  return {
    servers: snapshot.servers.map((server) => ({
      name: server.name,
      transport: server.transport,
      ...(server.endpoint ? { endpoint: server.endpoint } : {}),
      authMode: server.authMode,
      authStatus: server.authStatus,
      scopes: [...server.scopes],
      runtimeStatus: server.runtimeStatus,
    })),
  }
}

function assertLoginInput(input: unknown): asserts input is DesktopMcpLoginInput {
  if (
    !isRecord(input) ||
    typeof input.name !== "string" ||
    !Array.isArray(input.scopes) ||
    input.scopes.some((scope) => typeof scope !== "string")
  ) {
    throw new Error("MCP 登录参数无效。")
  }
}

function assertLogoutInput(input: unknown): asserts input is DesktopMcpLogoutInput {
  if (!isRecord(input) || typeof input.name !== "string") {
    throw new Error("MCP 退出登录参数无效。")
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
