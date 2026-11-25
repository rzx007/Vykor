import { useState } from "react"
import { ArrowDown, ArrowUp } from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import { Input } from "@renderer/components/ui/input"
import type { FilterableTableProps } from "./openui-library"

const display = (value: FilterableTableProps["rows"][number][number] | undefined) => String(value ?? "")

export function FilterableTable({ title, columns, rows }: FilterableTableProps) {
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState<{ column: number; descending: boolean }>()
  const search = query.trim().toLocaleLowerCase()
  const visible = rows.map((cells, index) => ({ cells, index })).filter(({ cells }) =>
    !search || cells.some((value) => display(value).toLocaleLowerCase().includes(search))
  )
  if (sort) {
    visible.sort((left, right) => {
      const a = left.cells[sort.column], b = right.cells[sort.column]
      let order = Number(typeof b === "number") - Number(typeof a === "number")
      if (order === 0) {
        order = typeof a === "number" && typeof b === "number"
          ? a - b
          : display(a).localeCompare(display(b), undefined, { numeric: true })
      }
      return sort.descending ? -order : order
    })
  }

  return (
    <figure className="my-3 min-w-0 space-y-2">
      <figcaption className="text-sm font-semibold">{title}</figcaption>
      <Input
        type="search"
        aria-label="筛选表格"
        placeholder="筛选表格"
        className="max-w-64"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full border-collapse text-sm" aria-label={title}>
          <thead>
            <tr className="border-b bg-muted/40">
              {columns.map((label, column) => {
                const direction = sort?.column === column
                  ? sort.descending ? "descending" : "ascending"
                  : undefined
                const SortIcon = direction === "descending" ? ArrowDown : ArrowUp
                return (
                  <th key={column} scope="col" aria-sort={direction} className="px-1 py-1 text-left">
                    <Button variant="ghost" size="sm" onClick={() => setSort({ column, descending: direction === "ascending" })}>
                      {label}
                      {direction ? <SortIcon aria-hidden="true" /> : null}
                    </Button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.map(({ cells, index }) => (
              <tr key={index}>
                {cells.map((value, column) => <td key={column} className="px-3 py-2 wrap-anywhere">{display(value)}</td>)}
              </tr>
            ))}
            {visible.length ? null : <tr><td colSpan={columns.length} className="px-3 py-2 text-muted-foreground">没有匹配结果</td></tr>}
          </tbody>
        </table>
      </div>
    </figure>
  )
}
