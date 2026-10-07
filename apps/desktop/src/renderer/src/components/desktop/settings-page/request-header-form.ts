export interface RequestHeaderRow {
  key: string
  name: string
  value: string
  secret?: boolean
  savedSecretName?: string
}

export type HeadersFromRowsResult =
  { ok: true; headers: Record<string, string>; secretHeaders?: Record<string, string | null> } | { ok: false; message: string }

export const REQUEST_HEADER_DESCRIPTION =
  "普通值支持 {{sessionId}}、{{userAgent}}，写入普通设置；机密值单独保存到宿主凭据，读取时只返回名称。"

export function rowsFromHeaders(headers?: Record<string, string>, secretNames: string[] = []): RequestHeaderRow[] {
  return [...Object.entries(headers ?? {}).map(([name, value], index) => ({
    key: `header-${index}`,
    name,
    value,
  })), ...secretNames.map((name, index) => ({ key: `secret-header-${index}`, name, value: "", secret: true, savedSecretName: name }))]
}

export function headersFromRows(rows: RequestHeaderRow[], previousSecretNames: string[] = []): HeadersFromRowsResult {
  const incomplete = rows.some((row) => !(row.secret && row.savedSecretName === row.name.trim()) && Boolean(row.name.trim()) !== Boolean(row.value.trim()))
  if (incomplete) {
    return { ok: false, message: "请求头名称和值需要同时填写。" }
  }
  const headers = Object.fromEntries(
    rows
      .filter((row) => !row.secret)
      .map((row) => [row.name.trim(), row.value.trim()] as const)
      .filter(([name, value]) => name && value)
  )
  if (new Set(rows.map((row) => row.name.trim().toLowerCase()).filter(Boolean)).size !== rows.filter((row) => row.name.trim()).length) return { ok: false, message: "请求头名称不能重复（不区分大小写）。" }
  const secretHeaders: Record<string, string | null> = {}
  for (const name of previousSecretNames) if (!rows.some((row) => row.secret && row.name.trim().toLowerCase() === name.toLowerCase())) secretHeaders[name] = null
  for (const row of rows.filter((row) => row.secret && row.value)) secretHeaders[row.name.trim()] = row.value
  return { ok: true, headers, ...(Object.keys(secretHeaders).length ? { secretHeaders } : {}) }
}
