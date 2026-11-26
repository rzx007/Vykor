import { useRef, useState } from "react"
import { ArrowDown, ArrowUp, ChevronsUpDown, Search, X } from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@renderer/components/ui/input-group"
import { cn } from "@renderer/lib/utils"
import type { FilterableTableProps } from "./openui-library"

const display = (value: FilterableTableProps["rows"][number][number] | undefined) =>
  String(value ?? "")

export function FilterableTable({
  title,
  columns,
  rows,
  streaming,
}: FilterableTableProps & { streaming: boolean }) {
  const searchInput = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState<{ column: number; descending: boolean }>()
  const search = query.trim().toLocaleLowerCase()
  const numericColumns = columns.map(
    (_, column) =>
      rows.some((cells) => typeof cells[column] === "number") &&
      rows.every((cells) => cells[column] === null || typeof cells[column] === "number")
  )
  const visible = rows
    .map((cells, index) => ({ cells, index }))
    .filter(
      ({ cells }) =>
        !search || cells.some((value) => display(value).toLocaleLowerCase().includes(search))
    )
  if (sort) {
    visible.sort((left, right) => {
      const a = left.cells[sort.column],
        b = right.cells[sort.column]
      let order = Number(typeof b === "number") - Number(typeof a === "number")
      if (order === 0) {
        order =
          typeof a === "number" && typeof b === "number"
            ? a - b
            : display(a).localeCompare(display(b), undefined, { numeric: true })
      }
      return sort.descending ? -order : order
    })
  }

  return (
    <figure className="my-3 flex w-full max-w-[min(100%,var(--chat-content-width))] min-w-0 flex-col gap-2.5">
      <figcaption className="text-sm font-semibold wrap-anywhere">{title}</figcaption>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <InputGroup shape="pill" className="h-8 w-64 max-w-full">
          <InputGroupAddon>
            <Search aria-hidden="true" strokeWidth={1.75} />
          </InputGroupAddon>
          <InputGroupInput
            ref={searchInput}
            role="searchbox"
            aria-label="筛选表格"
            placeholder="筛选表格"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          {query ? (
            <InputGroupAddon align="inline-end" className="py-0 pr-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                shape="circle"
                aria-label="清除筛选"
                onClick={() => {
                  setQuery("")
                  searchInput.current?.focus()
                }}
              >
                <X aria-hidden="true" />
              </Button>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
        {rows.length > 0 || !streaming ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {search ? `${visible.length} / ${rows.length} 行` : `共 ${rows.length} 行`}
          </span>
        ) : null}
      </div>
      <div
        role="region"
        aria-label={`滚动查看${title}`}
        tabIndex={0}
        className="max-h-[min(24rem,55dvh)] w-full min-w-0 overflow-auto overscroll-x-contain rounded-lg border border-border/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <table
          className="w-max min-w-full table-auto border-separate border-spacing-0 text-sm whitespace-nowrap"
          aria-label={title}
          aria-busy={streaming || undefined}
        >
          <thead className="sticky top-0 z-10 bg-background">
            <tr>
              {columns.map((label, column) => {
                const numeric = numericColumns[column]
                const direction =
                  sort?.column === column
                    ? sort.descending
                      ? "descending"
                      : "ascending"
                    : undefined
                const SortIcon = direction
                  ? direction === "descending"
                    ? ArrowDown
                    : ArrowUp
                  : ChevronsUpDown
                return (
                  <th
                    key={column}
                    scope="col"
                    aria-sort={direction}
                    className="border-b border-border/70 px-1.5 py-1"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "w-full justify-start px-1.5 motion-reduce:transition-none",
                        numeric && "flex-row-reverse",
                        direction ? "text-foreground" : "text-muted-foreground"
                      )}
                      onClick={() => setSort({ column, descending: direction === "ascending" })}
                    >
                      {label}
                      <SortIcon
                        aria-hidden="true"
                        data-icon={numeric ? "inline-start" : "inline-end"}
                        strokeWidth={1.75}
                      />
                    </Button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody className="[&>tr:last-child>td]:border-b-0">
            {visible.map(({ cells, index }) => (
              <tr key={index} className="hover:bg-muted/40">
                {cells.map((value, column) => (
                  <td
                    key={column}
                    className={cn(
                      "border-b border-border/45 px-3 py-2.5 align-middle",
                      numericColumns[column] && "text-right tabular-nums"
                    )}
                  >
                    {display(value)}
                  </td>
                ))}
              </tr>
            ))}
            {visible.length === 0 && (!streaming || rows.length > 0) ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-2.5 text-muted-foreground">
                  {search ? "没有匹配结果" : "暂无数据"}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </figure>
  )
}
