import { shell, type WebContents } from "electron"
import { randomUUID } from "node:crypto"
import type { VykorClient } from "@vykor/client"
import { VykorApiError } from "@vykor/client"
import {
  McpConfigApplicationService,
  type McpConfigOperationResult,
  type McpServerSummary,
} from "@vykor/server"
import type {
  DesktopMcpAddInput,
  DesktopMcpExportResult,
  DesktopMcpGetConfigInput,
  DesktopMcpLoginInput,
  DesktopMcpLoginOperationInput,
  DesktopMcpLoginState,
  DesktopMcpLogoutInput,
  DesktopMcpOperationResult,
  DesktopMcpRemoveInput,
  DesktopMcpSetEnabledInput,
  DesktopMcpSnapshot,
  DesktopMcpUpdateInput,
} from "@shared/mcp-types"
import { createDesktopMcpRuntimeCoordinator } from "./mcp-runtime-coordinator"
import { desktopSessionService } from "../session/session-service"

type McpConfigApplication = Pick<
  McpConfigApplicationService,
  "list" | "getConfig" | "exportConfig" | "add" | "update" | "remove" | "setEnabled"
>
export interface DesktopMcpServiceOptions {
  config?: McpConfigApplication
  openExternal?: (url: string) => Promise<void>
  daemonClient?: () => Promise<Pick<VykorClient, "protocol" | "mcp">>
}

type OperationView = Awaited<ReturnType<VykorClient["mcp"]["getLogin"]>>
type ActiveLogin = {
  client: Pick<VykorClient, "protocol" | "mcp">
  instanceId: string
  state: DesktopMcpLoginState
  opened: boolean
  opening?: Promise<void>
  controller: AbortController
  owner?: WebContents
  onOwnerDestroyed?: () => void
}

export class DesktopMcpService {
  private readonly config: McpConfigApplication
  private readonly openExternal: (url: string) => Promise<void>
  private readonly daemonClient: () => Promise<Pick<VykorClient, "protocol" | "mcp">>
  private readonly activeLogins = new Map<string, ActiveLogin>()

  constructor(options: DesktopMcpServiceOptions = {}) {
    const coordinator = createDesktopMcpRuntimeCoordinator()
    this.config = options.config ?? new McpConfigApplicationService({ coordinator })
    this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url))
    this.daemonClient = options.daemonClient ?? (() => desktopSessionService.daemonClient())
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

  async login(input: DesktopMcpLoginInput, owner?: WebContents): Promise<DesktopMcpLoginState> {
    assertLoginInput(input)
    const name = input.name.trim()
    const scopes = [...new Set(input.scopes.map((scope) => scope.trim()).filter(Boolean))]
    if (!name) throw new Error("请选择 MCP 服务。")
    // getClient completes the existing Desktop daemon takeover before the POST.
    const client = await this.daemonClient()
    const capabilities = await client.protocol.capabilities()
    if (owner?.isDestroyed()) throw new Error("MCP 窗口已关闭，授权未在此窗口启动。")
    const instanceId = capabilities.mcpOAuth?.instanceId
    if (capabilities.features.mcpOAuth !== 1 || !instanceId) {
      throw new Error("当前 daemon 不支持 MCP 授权，请更新或重启 daemon。")
    }
    const request = {
      oauthInstanceId: instanceId,
      requestId: randomUUID(),
      scopes,
      callbackMode: "local" as const,
    }
    if (this.activeLogins.size >= 100) {
      const finished = [...this.activeLogins].find(([, value]) => value.state.state !== "pending")
      if (finished) this.activeLogins.delete(finished[0])
      else throw new Error("正在进行的 MCP 授权操作过多，请稍后重试。")
    }
    let accepted: Awaited<ReturnType<typeof client.mcp.startLogin>>
    try { accepted = await client.mcp.startLogin(name, request) }
    catch (error) {
      // A lost 202 response may already have created the operation.
      if (!isNetworkFailure(error)) throw error
      const current = await client.protocol.capabilities()
      if (current.mcpOAuth?.instanceId !== instanceId) throw new Error("daemon 已重启，此次授权操作无法恢复。")
      accepted = await client.mcp.startLogin(name, request)
    }
    const active: ActiveLogin = {
      client, instanceId, state: safeLoginState(accepted.operation),
      opened: false, controller: new AbortController(), owner,
    }
    if (owner && !owner.isDestroyed()) {
      active.onOwnerDestroyed = () => {
        active.controller.abort()
        this.activeLogins.delete(accepted.loginId)
        this.releaseOwner(active)
      }
      owner.once("destroyed", active.onOwnerDestroyed)
    }
    if (owner?.isDestroyed()) active.controller.abort()
    if (active.controller.signal.aborted) return active.state
    this.activeLogins.set(accepted.loginId, active)
    try { await this.acceptView(active, accepted.operation) }
    catch (error) {
      try { active.state = safeLoginState(await client.mcp.cancelLogin(accepted.loginId)) } catch { /* best effort */ }
      this.releaseOwner(active)
      throw error
    }
    if (active.state.state === "pending") void this.watchLogin(accepted.loginId, active)
    return active.state
  }

  async loginStatus(input: DesktopMcpLoginOperationInput): Promise<DesktopMcpLoginState> {
    const active = this.requireActiveLogin(input)
    if (active.state.state !== "pending") return active.state
    await this.assertSameInstance(active)
    await this.acceptView(active, await active.client.mcp.getLogin(input.loginId))
    return active.state
  }

  async cancelLogin(input: DesktopMcpLoginOperationInput): Promise<DesktopMcpLoginState> {
    const active = this.requireActiveLogin(input)
    await this.assertSameInstance(active)
    const view = await active.client.mcp.cancelLogin(input.loginId)
    active.controller.abort()
    active.state = safeLoginState(view)
    this.releaseOwner(active)
    return active.state
  }

  async logout(input: DesktopMcpLogoutInput): Promise<DesktopMcpSnapshot> {
    assertLogoutInput(input)
    const name = input.name.trim()
    if (!name) throw new Error("请选择 MCP 服务。")
    const client = await this.daemonClient()
    const capabilities = await client.protocol.capabilities()
    if (capabilities.features.mcpOAuth !== 1 || !capabilities.mcpOAuth?.instanceId) {
      throw new Error("当前 daemon 不支持 MCP 授权，请更新或重启 daemon。")
    }
    try { await client.mcp.logout(name) }
    catch (error) {
      if (error instanceof VykorApiError && isRecord(error.body) && error.body.code === "oauth-removed-runtime-sync-failed") {
        throw new Error("OAuth 凭据已删除，但活动会话断开失败。")
      }
      throw error
    }
    return this.snapshot()
  }

  private requireActiveLogin(input: DesktopMcpLoginOperationInput): ActiveLogin {
    if (!isRecord(input) || typeof input.loginId !== "string") throw new Error("MCP 授权操作参数无效。")
    const active = this.activeLogins.get(input.loginId)
    if (!active) throw new Error("MCP 授权操作已过期，请重新发起。")
    return active
  }

  private async assertSameInstance(active: ActiveLogin): Promise<void> {
    const capabilities = await active.client.protocol.capabilities()
    if (capabilities.mcpOAuth?.instanceId !== active.instanceId) {
      throw new Error("daemon 已重启，此次授权操作无法恢复。")
    }
  }

  private async acceptView(active: ActiveLogin, view: OperationView): Promise<void> {
    active.state = { ...safeLoginState(view), ...(active.state.runtimeWarning ? { runtimeWarning: true } : {}) }
    if (view.state !== "pending") this.releaseOwner(active)
    if (active.controller.signal.aborted || active.opened || !view.authorizationReady || view.state !== "pending") return
    if (active.opening) return await active.opening
    active.opening = (async () => {
      const detail = view.authorizationUrl ? view : await active.client.mcp.getLogin(view.loginId)
      if (!detail.authorizationUrl || active.controller.signal.aborted) return
      await this.openAuthorizationUrl(detail.authorizationUrl)
      active.opened = true
    })().finally(() => { active.opening = undefined })
    await active.opening
  }

  private async watchLogin(loginId: string, active: ActiveLogin): Promise<void> {
    try {
      for await (const event of active.client.mcp.watchLogin(loginId, { signal: active.controller.signal })) {
        if (event.event === "mcp.oauth.login.updated") {
          await this.acceptView(active, event.data)
        } else {
          active.state = {
            ...safeLoginState(event.data),
            ...(event.data.runtimeSync?.failures.length || event.data.runtimeSync?.status === "error" ? { runtimeWarning: true } : {}),
          }
          this.releaseOwner(active)
          return
        }
      }
    } catch {
      // loginStatus retrieves the authoritative operation after a broken stream.
    }
  }

  private releaseOwner(active: ActiveLogin): void {
    if (active.owner && active.onOwnerDestroyed && !active.owner.isDestroyed()) {
      active.owner.removeListener("destroyed", active.onOwnerDestroyed)
    }
    active.owner = undefined
    active.onOwnerDestroyed = undefined
  }

  private async toOperationResult(
    result: McpConfigOperationResult
  ): Promise<DesktopMcpOperationResult> {
    return { ...result, snapshot: await this.snapshot() }
  }

  private async openAuthorizationUrl(value: string): Promise<void> {
    let target: URL
    try { target = new URL(value) } catch { throw new Error("OAuth 授权地址无效。") }
    if (target.protocol !== "https:" || target.username || target.password || target.hash) {
      throw new Error("OAuth 授权地址必须是安全的 HTTPS URL。")
    }
    try { await this.openExternal(target.href) }
    catch { throw new Error("无法打开 OAuth 授权页面，请稍后重试。") }
  }
}

function safeLoginState(view: OperationView): DesktopMcpLoginState {
  return {
    loginId: view.loginId,
    name: view.name,
    state: view.state,
    credentialCommitted: view.credentialCommitted,
    authorizationReady: view.authorizationReady,
    ...(view.errorCode ? { errorCode: view.errorCode } : {}),
    ...(view.runtimeSync?.failures.length || view.runtimeSync?.status === "error" ? { runtimeWarning: true } : {}),
  }
}

function isNetworkFailure(error: unknown): boolean {
  if (error instanceof VykorApiError) return false
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) return true
  let current = error as { code?: string; cause?: unknown } | undefined
  for (let i = 0; current && i < 5; i++, current = current.cause as typeof current) {
    if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH"].includes(current.code ?? "")) return true
  }
  return false
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
