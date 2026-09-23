export type McpConfig = Record<string, unknown>
export interface McpEntry {
  name: string
  config: McpConfig
}
export interface McpDocument {
  servers: McpEntry[]
  extras: McpConfig
  wrapped: boolean
}
type ParseOptions = {
  allowIncomplete?: boolean
  existingNames?: string[]
  /** When editing an existing server, its stable name (renames are rejected). */
  editingName?: string
}
type StorageAccess = Pick<Storage, "getItem" | "setItem">
export type McpPairs = [string, string][]

const REAL_FIELDS = new Set(["type", "command", "args", "env", "cwd", "url", "headers", "oauth", "enabled"])
const REMOVED_FIELDS = new Set([
  "env_vars",
  "bearer_token_env_var",
  "http_headers",
  "env_http_headers",
])
const OAUTH_FIELDS = new Set(["scopes", "clientId", "callbackPort"])

function object(value: unknown): value is McpConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// JSON.parse silently discards duplicate keys. Check the already syntax-validated
// token stream too, including escaped names, before importing any configuration.
function checkDuplicateKeys(text: string): void {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|[^\s{}[\]:,]+/g) ?? []
  let cursor = 0
  function visit(): void {
    const token = tokens[cursor++]
    if (token === "{") {
      const names = new Set<string>()
      while (tokens[cursor] !== "}") {
        const name = JSON.parse(tokens[cursor++]) as string
        if (names.has(name)) throw new Error(`JSON 中存在重复字段或名称：${name}`)
        names.add(name)
        cursor++ // colon
        visit()
        if (tokens[cursor] === ",") cursor++
      }
      cursor++
    } else if (token === "[") {
      while (tokens[cursor] !== "]") {
        visit()
        if (tokens[cursor] === ",") cursor++
      }
      cursor++
    }
  }
  visit()
}

export function mcpTransport(config: McpConfig): "stdio" | "http" | "sse" {
  if (config.type === "sse") return "sse"
  if (config.type === "http") return "http"
  if (config.type === undefined && config.url !== undefined) return "http"
  return "stdio"
}

/**
 * Validate one entry against the real `McpServerConfig` shape. Demo-only fields
 * (`env_vars`, `bearer_token_env_var`, `http_headers`, `env_http_headers`) and
 * unknown fields are rejected so the editor can never persist a config the
 * Runtime would not honor.
 */
export function validateMcpEntry(entry: McpEntry, allowIncomplete = false): void {
  const { name, config } = entry
  const fail = (message: string): never => {
    throw new Error(`${name || "未命名服务器"}：${message}`)
  }
  if (!allowIncomplete && !name.trim()) fail("名称不能为空")
  for (const key of Object.keys(config)) {
    if (REMOVED_FIELDS.has(key)) fail(`字段 ${key} 已不再支持；请改用真实的 headers / env 配置`)
    if (!REAL_FIELDS.has(key)) fail(`不支持的字段：${key}`)
  }
  if (config.type !== undefined && !["stdio", "http", "sse"].includes(config.type as string))
    fail("type 只能是 stdio、http 或 sse")
  if (config.type === undefined && config.command !== undefined && config.url !== undefined)
    fail("同时包含 command 和 url 时，请明确指定 type")
  const transport = mcpTransport(config)

  for (const key of ["command", "url", "cwd"] as const) {
    if (config[key] !== undefined && typeof config[key] !== "string") fail(`${key} 必须是字符串`)
  }
  if (
    config.args !== undefined &&
    (!Array.isArray(config.args) || config.args.some((value) => typeof value !== "string"))
  )
    fail("args 必须是字符串数组")
  for (const key of ["env", "headers"] as const) {
    const value = config[key]
    if (value === undefined) continue
    if (!object(value)) fail(`${key} 必须是键值对象`)
    for (const [k, v] of Object.entries(value as McpConfig)) {
      if (typeof v !== "string") fail(`${key}.${k} 必须是字符串`)
      if (!allowIncomplete && !k.trim()) fail(`${key} 的键不能为空`)
    }
  }
  validateOAuth(config.oauth, fail, allowIncomplete)
  if (config.enabled !== undefined && typeof config.enabled !== "boolean")
    fail("enabled 必须是布尔值")
  if (allowIncomplete) return

  if (transport === "stdio") {
    if (typeof config.command !== "string" || !config.command.trim()) fail("command 不能为空")
    if (config.url !== undefined || config.headers !== undefined || config.oauth !== undefined)
      fail("stdio 配置不能包含 url、headers 或 oauth")
    return
  }
  const rawUrl = config.url
  if (typeof rawUrl !== "string" || !rawUrl.trim()) fail("url 不能为空")
  try {
    const url = new URL(String(rawUrl))
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw new Error()
  } catch {
    fail("url 必须是有效的 http:// 或 https:// URL")
  }
  if (
    config.command !== undefined ||
    config.args !== undefined ||
    config.env !== undefined ||
    config.cwd !== undefined
  )
    fail("远程配置不能包含 command、args、env 或 cwd")
}

function validateOAuth(
  oauth: unknown,
  fail: (message: string) => never,
  allowIncomplete: boolean
): void {
  if (oauth === undefined) return
  if (!object(oauth)) fail("oauth 必须是对象")
  for (const key of Object.keys(oauth as McpConfig)) {
    if (!OAUTH_FIELDS.has(key)) fail(`oauth 不支持的字段：${key}`)
  }
  const value = oauth as McpConfig
  if (
    value.scopes !== undefined &&
    (!Array.isArray(value.scopes) || value.scopes.some((scope) => typeof scope !== "string"))
  )
    fail("oauth.scopes 必须是字符串数组")
  if (value.clientId !== undefined && typeof value.clientId !== "string")
    fail("oauth.clientId 必须是字符串")
  if (value.callbackPort !== undefined && typeof value.callbackPort !== "number")
    fail("oauth.callbackPort 必须是数字")
  if (
    !allowIncomplete &&
    Array.isArray(value.scopes) &&
    value.scopes.some((scope) => !(scope as string).trim())
  )
    fail("oauth.scopes 不能包含空值")
}

export function parseMcpJson(text: string, options: ParseOptions = {}): McpDocument {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `JSON 语法错误：${error instanceof Error ? error.message : "请检查括号、引号和逗号"}`
    )
  }
  checkDuplicateKeys(text)
  if (!object(value)) throw new Error("配置必须是 JSON 对象")
  let servers: McpEntry[]
  let extras: McpConfig = {}
  const wrapped = Object.hasOwn(value, "mcpServers")
  if (wrapped) {
    const { mcpServers, ...rest } = value
    if (!object(mcpServers)) throw new Error("mcpServers 必须是名称与配置组成的对象")
    servers = Object.entries(mcpServers).map(([name, config]) => {
      if (!object(config)) throw new Error(`${name} 的配置必须是对象`)
      return { name, config }
    })
    extras = rest
  } else {
    const { name, ...config } = value
    if (typeof name !== "string") throw new Error("单个配置必须包含字符串 name 字段")
    servers = [{ name, config }]
  }
  if (!servers.length) throw new Error("请添加至少一个 MCP 服务器")

  const editingName = options.editingName?.trim()
  const existing = new Set((options.existingNames ?? []).map((name) => name.trim()))
  if (editingName) existing.delete(editingName)
  const names = new Set<string>()
  for (const entry of servers) {
    validateMcpEntry(entry, options.allowIncomplete)
    const key = entry.name.trim()
    if (names.has(key)) throw new Error(`名称重复：${key || "空名称"}`)
    if (existing.has(key)) throw new Error(`名称已存在：${key}。请使用其他名称，或编辑已有配置。`)
    names.add(key)
  }
  if (editingName !== undefined) {
    if (servers.length !== 1) throw new Error("编辑已有服务时只能包含一个服务器")
    if (servers[0].name.trim() !== editingName) throw new Error("编辑已有服务时不能修改名称")
  }
  return { servers, extras, wrapped }
}

export function serializeMcpDocument(doc: McpDocument): string {
  const names = new Set<string>()
  for (const server of doc.servers) {
    const name = server.name.trim()
    if (names.has(name)) throw new Error(`名称重复：${name || "空名称"}`)
    names.add(name)
  }
  if (!doc.wrapped && doc.servers.length === 1) {
    return JSON.stringify({ ...doc.servers[0].config, name: doc.servers[0].name }, null, 2)
  }
  return JSON.stringify(
    { ...doc.extras, mcpServers: Object.fromEntries(doc.servers.map((s) => [s.name, s.config])) },
    null,
    2
  )
}

export interface McpForm {
  original: McpEntry
  name: string
  type: "stdio" | "http" | "sse"
  command: string
  args: string[]
  env: McpPairs
  cwd: string
  url: string
  headers: McpPairs
  scopes: string[]
}

export function toMcpForm(entry: McpEntry): McpForm {
  const c = entry.config
  const oauth = object(c.oauth) ? c.oauth : undefined
  return {
    original: entry,
    name: entry.name,
    type: mcpTransport(c),
    command: (c.command as string) ?? "",
    args: (c.args as string[]) ?? [],
    env: Object.entries((c.env as Record<string, string>) ?? {}),
    cwd: (c.cwd as string) ?? "",
    url: (c.url as string) ?? "",
    headers: Object.entries((c.headers as Record<string, string>) ?? {}),
    scopes: [...((oauth?.scopes as string[]) ?? [])],
  }
}

export function fromMcpForm(form: McpForm): McpEntry {
  const original = form.original.config
  const config: McpConfig = {}
  if (original.enabled !== undefined) config.enabled = original.enabled

  if (form.type === "stdio") {
    config.type = "stdio"
    config.command = form.command
    if (form.args.length) config.args = [...form.args]
    const env = pairsToObject(form.env, "env")
    if (env) config.env = env
    if (form.cwd.trim()) config.cwd = form.cwd
    return { name: form.name, config }
  }

  config.type = form.type
  config.url = form.url
  const headers = pairsToObject(form.headers, "headers")
  if (headers) config.headers = headers

  const originalOauth = object(original.oauth) ? original.oauth : undefined
  const scopes = form.scopes.map((scope) => scope.trim()).filter(Boolean)
  if (scopes.length) {
    config.oauth = { ...(originalOauth ?? {}), scopes }
  } else if (originalOauth?.clientId !== undefined || originalOauth?.callbackPort !== undefined) {
    const { scopes: _scopes, ...rest } = originalOauth
    config.oauth = rest
  }
  return { name: form.name, config }
}

function pairsToObject(pairs: McpPairs, label: string): McpConfig | undefined {
  const result: McpConfig = {}
  const names = new Set<string>()
  let hasValue = false
  for (const [key, value] of pairs) {
    if (!key.trim() && !value.trim()) continue
    if (!key.trim()) throw new Error(`${label} 的键不能为空；请填写或移除此行`)
    const normalized = label === "env" ? key : key.toLowerCase()
    if (names.has(normalized)) throw new Error(`${label} 中存在重复键：${key}`)
    names.add(normalized)
    result[key] = value
    hasValue = true
  }
  return hasValue ? result : undefined
}

export const mcpStorageKey = (projectPath: string): string =>
  `openharness:mcp:local:v1:${JSON.stringify(projectPath)}`
export const emptyMcpDocument = (): McpDocument => ({ servers: [], extras: {}, wrapped: true })

export function loadMcpStorage(
  storage: StorageAccess,
  projectPath: string
): { document: McpDocument; raw: string | null } {
  const raw = storage.getItem(mcpStorageKey(projectPath))
  if (raw === null) return { document: emptyMcpDocument(), raw }
  const value: unknown = JSON.parse(raw)
  if (!object(value) || value.version !== 1 || !object(value.document))
    throw new Error("本机 MCP 配置格式无效，原始数据已保留")
  const document = value.document
  if (!Array.isArray(document.servers) || !object(document.extras))
    throw new Error("本机 MCP 配置格式无效，原始数据已保留")
  const servers = document.servers.map((s: unknown): McpEntry => {
    if (!object(s) || typeof s.name !== "string" || !object(s.config))
      throw new Error("本机 MCP 配置格式无效")
    return { name: s.name, config: s.config }
  })
  if (servers.length)
    parseMcpJson(serializeMcpDocument({ servers, extras: document.extras, wrapped: true }))
  return { document: { servers, extras: document.extras, wrapped: true }, raw }
}

export function saveMcpStorage(
  storage: StorageAccess,
  projectPath: string,
  document: McpDocument,
  expectedRaw: string | null
): string {
  if (storage.getItem(mcpStorageKey(projectPath)) !== expectedRaw)
    throw new Error("本机配置已被其他窗口修改，请刷新后重试；当前编辑内容已保留")
  if (document.servers.length) parseMcpJson(serializeMcpDocument({ ...document, wrapped: true }))
  const raw = JSON.stringify({ version: 1, document: { ...document, wrapped: true } })
  storage.setItem(mcpStorageKey(projectPath), raw)
  return raw
}
