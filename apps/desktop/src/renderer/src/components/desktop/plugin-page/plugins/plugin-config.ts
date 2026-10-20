export interface PluginConfig {
  id: string
  name: string
  description: string
  source: string
  version: string
  enabled: boolean
  catalogId?: string
}

export function parsePluginConfig(text: string): Omit<PluginConfig, "id" | "enabled"> {
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch {
    throw new Error("JSON 格式不正确，请检查引号、逗号和括号。")
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("插件配置必须是一个 JSON 对象。")
  const value = input as Record<string, unknown>
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("请填写插件名称 name。")
  for (const key of ["description", "source", "version", "catalogId"]) {
    if (value[key] !== undefined && typeof value[key] !== "string")
      throw new Error(`${key} 必须是文本。`)
  }
  return {
    ...value,
    name: value.name.trim(),
    description: (value.description as string | undefined)?.trim() ?? "",
    source: (value.source as string | undefined)?.trim() ?? "",
    version: (value.version as string | undefined)?.trim() || "1.0.0",
    ...(typeof value.catalogId === "string" ? { catalogId: value.catalogId } : {}),
  }
}

export function readPluginConfigs(storage: Pick<Storage, "getItem">, key: string): PluginConfig[] {
  const raw = storage.getItem(key)
  if (!raw) return []
  const saved: unknown = JSON.parse(raw)
  if (
    !saved ||
    typeof saved !== "object" ||
    !("version" in saved) ||
    saved.version !== 1 ||
    !("items" in saved) ||
    !Array.isArray(saved.items)
  )
    throw new Error("本地插件配置无法读取，原始数据已保留。")
  const items = saved.items.map((item: unknown) => {
    if (
      !item ||
      typeof item !== "object" ||
      !("id" in item) ||
      typeof item.id !== "string" ||
      !("enabled" in item) ||
      typeof item.enabled !== "boolean"
    )
      throw new Error("本地插件配置不完整，原始数据已保留。")
    return { ...parsePluginConfig(JSON.stringify(item)), id: item.id, enabled: item.enabled }
  })
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new Error("本地插件配置包含重复记录，原始数据已保留。")
  return items
}

export const pluginConfigKey = (projectPath: string): string =>
  `vykor:plugin-configs:v1:${projectPath}`

export function savePluginConfigs(
  storage: Pick<Storage, "getItem" | "setItem">,
  key: string,
  items: PluginConfig[],
  expectedRaw: string | null
): string {
  if (storage.getItem(key) !== expectedRaw)
    throw new Error("其他窗口已修改插件配置，请先复制当前草稿，再刷新列表重试。")
  const raw = JSON.stringify({ version: 1, items })
  try {
    storage.setItem(key, raw)
  } catch {
    throw new Error("本地保存失败，请检查可用存储空间后重试。")
  }
  return raw
}
