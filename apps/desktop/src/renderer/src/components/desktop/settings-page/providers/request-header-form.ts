export interface RequestHeaderRow {
  key: string
  name: string
  value: string
  secret?: boolean
  savedSecretName?: string
}

export type RequestHeaderError = {
  ok: false
  message: string
  rowKey: string
  field: "name" | "value"
}

export type HeadersFromRowsResult =
  | { ok: true; headers: Record<string, string>; secretHeaders?: Record<string, string | null> }
  | RequestHeaderError

export const REQUEST_HEADER_DESCRIPTION =
  "普通值支持 {{sessionId}}、{{userAgent}}，写入普通设置；机密值单独保存到宿主凭据，读取时只返回名称。"

export function rowsFromHeaders(
  headers?: Record<string, string>,
  secretNames: string[] = []
): RequestHeaderRow[] {
  return [
    ...Object.entries(headers ?? {}).map(([name, value], index) => ({
      key: `header-${index}`,
      name,
      value,
    })),
    ...secretNames.map((name, index) => ({
      key: `secret-header-${index}`,
      name,
      value: "",
      secret: true,
      savedSecretName: name,
    })),
  ]
}

export function headersFromRows(
  rows: RequestHeaderRow[],
  previousSecretNames: string[] = []
): HeadersFromRowsResult {
  const incomplete = rows.find(
    (row) =>
      !(row.secret && row.savedSecretName === row.name.trim()) &&
      Boolean(row.name.trim()) !== Boolean(row.value.trim())
  )
  if (incomplete) {
    return {
      ok: false,
      rowKey: incomplete.key,
      field: incomplete.name.trim() ? "value" : "name",
      message: "请求头名称和值需要同时填写。",
    }
  }
  const headers = Object.fromEntries(
    rows
      .filter((row) => !row.secret)
      .map((row) => [row.name.trim(), row.value.trim()] as const)
      .filter(([name, value]) => name && value)
  )
  const names = new Set<string>()
  for (const row of rows) {
    const name = row.name.trim().toLowerCase()
    if (!name) continue
    if (names.has(name)) {
      return {
        ok: false,
        rowKey: row.key,
        field: "name",
        message: "请求头名称不能重复（不区分大小写）。",
      }
    }
    names.add(name)
  }
  const secretHeaders: Record<string, string | null> = {}
  for (const name of previousSecretNames)
    if (!rows.some((row) => row.secret && row.name.trim().toLowerCase() === name.toLowerCase()))
      secretHeaders[name] = null
  for (const row of rows.filter((row) => row.secret && row.value))
    secretHeaders[row.name.trim()] = row.value
  return { ok: true, headers, ...(Object.keys(secretHeaders).length ? { secretHeaders } : {}) }
}
