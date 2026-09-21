import { useEffect, useState } from "react"
import { Badge } from "@renderer/components/ui/badge"
import { Button } from "@renderer/components/ui/button"
import { Card, CardContent } from "@renderer/components/ui/card"
import { Input } from "@renderer/components/ui/input"
import { Spinner } from "@renderer/components/ui/spinner"
import type {
  DesktopMcpAuthMode,
  DesktopMcpAuthStatus,
  DesktopMcpRuntimeStatus,
  DesktopMcpServer,
} from "@shared/mcp-types"
import { errorMessage } from "./settings-error-message"

const authModeLabels: Record<DesktopMcpAuthMode, string> = {
  none: "未配置认证",
  oauth: "OAuth",
  bearer: "Bearer",
  custom: "自定义认证",
}

const authStatusLabels: Record<DesktopMcpAuthStatus, string> = {
  "not-configured": "未配置",
  "not-logged-in": "未登录",
  valid: "已连接",
  "expired-refreshable": "待刷新",
  "reauthentication-required": "需要重新登录",
  static: "静态凭据",
  unsupported: "不支持 OAuth",
}

const runtimeStatusLabels: Record<DesktopMcpRuntimeStatus, string> = {
  connected: "Runtime 已连接",
  disconnected: "Runtime 未运行",
  error: "Runtime 连接失败",
  unavailable: "Runtime 状态不可用",
}

export function McpSettings(): React.JSX.Element {
  const [servers, setServers] = useState<DesktopMcpServer[]>([])
  const [scopeInputs, setScopeInputs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.desktop.mcp
      .snapshot()
      .then((snapshot) => {
        if (cancelled) return
        setServers(snapshot.servers)
        setScopeInputs(
          Object.fromEntries(
            snapshot.servers.map((server) => [server.name, server.scopes.join(", ")])
          )
        )
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const login = (server: DesktopMcpServer): void => {
    setBusy(server.name)
    setError(null)
    const scopes = (scopeInputs[server.name] ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean)
    void window.desktop.mcp
      .login({ name: server.name, scopes })
      .then((snapshot) => setServers(snapshot.servers))
      .catch((cause: unknown) => {
        // The credential may already be saved even when the runtime failed to
        // reconnect; refresh so the page still shows the saved auth state.
        setError(errorMessage(cause))
        void window.desktop.mcp
          .snapshot()
          .then((snapshot) => setServers(snapshot.servers))
          .catch(() => undefined)
      })
      .finally(() => setBusy(null))
  }

  const logout = (server: DesktopMcpServer): void => {
    setBusy(server.name)
    setError(null)
    void window.desktop.mcp
      .logout({ name: server.name })
      .then((snapshot) => setServers(snapshot.servers))
      .catch((cause: unknown) => {
        setError(errorMessage(cause))
        void window.desktop.mcp
          .snapshot()
          .then((snapshot) => setServers(snapshot.servers))
          .catch(() => undefined)
      })
      .finally(() => setBusy(null))
  }

  if (loading)
    return (
      <div
        className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"
        aria-live="polite"
      >
        <Spinner /> 正在读取 MCP 服务…
      </div>
    )

  return (
    <div className="flex flex-col gap-4" aria-busy={busy !== null}>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {servers.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            尚未配置 MCP 服务。可先使用 <code>ohs mcp add</code> 添加服务。
          </CardContent>
        </Card>
      ) : (
        servers.map((server) => (
          <Card key={server.name}>
            <CardContent className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-heading text-base font-semibold">{server.name}</h2>
                  <Badge variant="outline">{authModeLabels[server.authMode]}</Badge>
                  <Badge variant={badgeVariant(server.authStatus)}>
                    {authStatusLabels[server.authStatus]}
                  </Badge>
                  <Badge variant={runtimeBadgeVariant(server.runtimeStatus)}>
                    {runtimeStatusLabels[server.runtimeStatus]}
                  </Badge>
                  <Badge variant="outline">{server.transport}</Badge>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {endpointLabel(server)}
                </p>
                {server.scopes.length ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    权限：{server.scopes.join(", ")}
                  </p>
                ) : null}
              </div>
              {server.transport === "http" && server.authMode === "oauth" ? (
                <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-64">
                  {canLogin(server.authStatus) ? (
                    <div className="flex flex-col gap-1">
                      <Input
                        aria-label={`${server.name} OAuth scopes`}
                        value={scopeInputs[server.name] ?? ""}
                        placeholder="权限，例如 read"
                        disabled={busy === server.name}
                        onChange={(event) =>
                          setScopeInputs((current) => ({
                            ...current,
                            [server.name]: event.target.value,
                          }))
                        }
                      />
                      <p className="text-xs text-muted-foreground">多个权限请用逗号分隔。</p>
                    </div>
                  ) : null}
                  <Button
                    size="sm"
                    variant={canLogout(server.authStatus) ? "outline" : "default"}
                    disabled={busy !== null}
                    onClick={() => (canLogout(server.authStatus) ? logout(server) : login(server))}
                  >
                    {busy === server.name ? <Spinner /> : null}
                    {actionLabel(server.authStatus)}
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  )
}

function canLogin(status: DesktopMcpAuthStatus): boolean {
  return status === "not-logged-in" || status === "reauthentication-required"
}

function actionLabel(status: DesktopMcpAuthStatus): string {
  if (canLogout(status)) return "退出登录"
  return status === "reauthentication-required" ? "重新授权" : "浏览器授权"
}

function endpointLabel(server: DesktopMcpServer): string {
  if (server.endpoint) return server.endpoint
  return server.transport === "stdio" ? "本地进程服务" : "地址无效或已隐藏"
}

function canLogout(status: DesktopMcpAuthStatus): boolean {
  return status === "valid" || status === "expired-refreshable"
}

function badgeVariant(
  status: DesktopMcpAuthStatus
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "valid") return "default"
  if (status === "reauthentication-required") return "destructive"
  if (status === "expired-refreshable") return "secondary"
  return "outline"
}

function runtimeBadgeVariant(
  status: DesktopMcpRuntimeStatus
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "error") return "destructive"
  if (status === "connected") return "secondary"
  return "outline"
}
