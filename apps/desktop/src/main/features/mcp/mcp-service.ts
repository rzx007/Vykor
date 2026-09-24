import { shell } from "electron"
import {
  McpConfigApplicationService,
  McpOAuthApplicationService,
  type McpConfigOperationResult,
  type McpServerSummary,
} from "@vykor/server"
import type {
  DesktopMcpAddInput,
  DesktopMcpExportResult,
  DesktopMcpGetConfigInput,
  DesktopMcpLoginInput,
  DesktopMcpLogoutInput,
  DesktopMcpOperationResult,
  DesktopMcpRemoveInput,
  DesktopMcpSetEnabledInput,
  DesktopMcpSnapshot,
  DesktopMcpUpdateInput,
} from "@shared/mcp-types"
import { createDesktopMcpRuntimeCoordinator } from "./mcp-runtime-coordinator"

type McpConfigApplication = Pick<
  McpConfigApplicationService,
  "list" | "getConfig" | "exportConfig" | "add" | "update" | "remove" | "setEnabled"
>
type McpOAuthApplication = Pick<McpOAuthApplicationService, "login" | "logout">

export interface DesktopMcpServiceOptions {
  config?: McpConfigApplication
  oauth?: McpOAuthApplication
  openExternal?: (url: string) => Promise<void>
}

export class DesktopMcpService {
  private readonly config: McpConfigApplication
  private readonly oauth: McpOAuthApplication
  private readonly openExternal: (url: string) => Promise<void>

  constructor(options: DesktopMcpServiceOptions = {}) {
    const coordinator = createDesktopMcpRuntimeCoordinator()
    this.config = options.config ?? new McpConfigApplicationService({ coordinator })
    this.oauth = options.oauth ?? new McpOAuthApplicationService({ coordinator })
    this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url))
  }

  /** Secret-free list snapshot with enabled state, safe summary and split auth/runtime status. */
  async snapshot(): Promise<DesktopMcpSnapshot> {
    return toDesktopSnapshot(await this.config.list())
  }

  /** Full config, returned only for an explicit edit request. */
  async getConfig(input: DesktopMcpGetConfigInput): Promise<Record<string, unknown>> {
    const name = requireName(input, "读取 MCP 配置参数无效。")
    return { ...(await this.config.getConfig(name)) } as Record<string, unknown>
  }

  /** The global `mcpServers` map only. */
  async exportConfig(): Promise<DesktopMcpExportResult> {
    const { mcpServers } = await this.config.exportConfig()
    return { mcpServers: { ...mcpServers } as Record<string, unknown> }
  }

  async add(input: DesktopMcpAddInput): Promise<DesktopMcpOperationResult> {
    const name = requireName(input, "MCP 添加参数无效。")
    requireConfig(input, "MCP 配置无效。")
    return this.toOperationResult(await this.config.add({ name, config: input.config }))
  }

  async update(input: DesktopMcpUpdateInput): Promise<DesktopMcpOperationResult> {
    const name = requireName(input, "MCP 更新参数无效。")
    requireConfig(input, "MCP 配置无效。")
    if (!isRecord(input.expectedConfig)) throw new Error("MCP 原始配置无效。")
    return this.toOperationResult(
      await this.config.update({ name, config: input.config, expectedConfig: input.expectedConfig })
    )
  }

  async remove(input: DesktopMcpRemoveInput): Promise<DesktopMcpOperationResult> {
    const name = requireName(input, "MCP 移除参数无效。")
    return this.toOperationResult(await this.config.remove(name))
  }

  async setEnabled(input: DesktopMcpSetEnabledInput): Promise<DesktopMcpOperationResult> {
    const name = requireName(input, "MCP 启停参数无效。")
    if (typeof input.enabled !== "boolean") throw new Error("MCP 启停参数无效。")
    return this.toOperationResult(await this.config.setEnabled({ name, enabled: input.enabled }))
  }

  async login(input: DesktopMcpLoginInput): Promise<DesktopMcpSnapshot> {
    assertLoginInput(input)
    const name = input.name.trim()
    const scopes = [...new Set(input.scopes.map((scope) => scope.trim()).filter(Boolean))]
    if (!name) throw new Error("请选择 MCP 服务。")
    await this.oauth.login({
      name,
      scopes,
      openBrowser: (url) => this.openAuthorizationUrl(url),
    })
    return this.snapshot()
  }

  async logout(input: DesktopMcpLogoutInput): Promise<DesktopMcpSnapshot> {
    assertLogoutInput(input)
    const name = input.name.trim()
    if (!name) throw new Error("请选择 MCP 服务。")
    await this.oauth.logout(name)
    return this.snapshot()
  }

  private async toOperationResult(
    result: McpConfigOperationResult
  ): Promise<DesktopMcpOperationResult> {
    return { ...result, snapshot: await this.snapshot() }
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

function toDesktopSnapshot(snapshot: { servers: McpServerSummary[] }): DesktopMcpSnapshot {
  return {
    servers: snapshot.servers.map((server) => ({
      name: server.name,
      enabled: server.enabled,
      transport: server.transport,
      summary: server.summary,
      authMode: server.authMode,
      authStatus: server.authStatus,
      scopes: [...server.scopes],
      runtimeStatus: server.runtimeStatus,
    })),
  }
}

function requireName(input: unknown, message: string): string {
  if (!isRecord(input) || typeof input.name !== "string" || !input.name.trim()) {
    throw new Error(message)
  }
  return input.name
}

function requireConfig(input: unknown, message: string): void {
  if (!isRecord(input) || !isRecord((input as { config?: unknown }).config)) {
    throw new Error(message)
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
