import { useMemo, type ReactNode } from "react"
import { FilterableTable } from "./filterable-table"
import { readInteractiveTable } from "./openui-library"

export default function InteractiveUiBlock({ code, fallback }: { code: string; fallback: ReactNode }) {
  const table = useMemo(() => {
    try {
      return readInteractiveTable(code)
    } catch {
      return null
    }
  }, [code])
  return table ? <FilterableTable key={code} {...table} /> : fallback
}
