import { useMemo, useState, type ReactNode } from "react"
import { FilterableTable } from "./filterable-table"
import { createInteractiveTableReader } from "./openui-library"

export default function InteractiveUiBlock({
  code,
  closed,
  fallback,
}: {
  code: string
  closed: boolean
  fallback: ReactNode
}) {
  const [readTable] = useState(createInteractiveTableReader)
  const table = useMemo(() => readTable(code, closed), [readTable, code, closed])
  return table ? <FilterableTable {...table} streaming={!closed} /> : fallback
}
