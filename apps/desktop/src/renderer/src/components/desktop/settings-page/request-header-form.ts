export interface RequestHeaderRow {
  key: string
  name: string
  value: string
}

export type HeadersFromRowsResult =
  { ok: true; headers: Record<string, string> } | { ok: false; message: string }

export const REQUEST_HEADER_DESCRIPTION =
  "支持 {{sessionId}}、{{userAgent}}；明文写入 settings.json，勿填密钥。"

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
