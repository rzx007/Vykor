import { useMemo, useState, type ReactNode } from "react"
import { FilterableTable } from "./filterable-table"
import { createInteractiveTableReader } from "./openui-library"
import { parseRichUiContent } from "./parse-rich-ui-content"
import { RichUiCard } from "./rich-ui-content"

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
  const rich = useMemo(() => (closed ? parseRichUiContent(code) : null), [code, closed])
  if (table) return <FilterableTable {...table} streaming={!closed} />
  return rich ? <RichUiCard key={JSON.stringify(rich)} content={rich} /> : fallback
}
