export interface RequestHeaderRow {
  key: string
  name: string
  value: string
}

export type HeadersFromRowsResult =
  { ok: true; headers: Record<string, string> } | { ok: false; message: string }

export const REQUEST_HEADER_DESCRIPTION =
  "用于租户或网关路由信息。值可以使用 {{sessionId}} 和 {{userAgent}}，发送请求时会替换为当前会话和客户端标识。请求头会明文保存在 settings.json，请勿填写 API Key 或 Bearer Token。"

export function rowsFromHeaders(headers?: Record<string, string>): RequestHeaderRow[] {
  return Object.entries(headers ?? {}).map(([name, value], index) => ({
    key: `header-${index}`,
    name,
    value,
  }))
}

export function headersFromRows(rows: RequestHeaderRow[]): HeadersFromRowsResult {
  const incomplete = rows.some((row) => Boolean(row.name.trim()) !== Boolean(row.value.trim()))
  if (incomplete) {
    return { ok: false, message: "请求头名称和值需要同时填写。" }
  }
  const headers = Object.fromEntries(
    rows
      .map((row) => [row.name.trim(), row.value.trim()] as const)
      .filter(([name, value]) => name && value)
  )
  return { ok: true, headers }
}
