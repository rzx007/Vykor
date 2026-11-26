import { createStreamingParser } from "@openuidev/lang-core"
import { z } from "zod/v4"
import { readFilterableTablePrefix } from "./filterable-table-stream"

const cell = z.union([z.string().max(160), z.number(), z.boolean(), z.null()])
const tableProps = z.object({
  title: z.string().trim().min(1).max(160),
  columns: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
  rows: z.array(z.array(cell).max(8)).max(100),
})

export type FilterableTableProps = z.infer<typeof tableProps>

const tableName = "FilterableTable"
const librarySchema = {
  $defs: { [tableName]: z.toJSONSchema(tableProps) },
  properties: { [tableName]: { $ref: `#/$defs/${tableName}` } },
}
const tableCall = `root = ${tableName}(`

export function createInteractiveTableReader() {
  const parser = createStreamingParser(librarySchema, tableName)
  return (source: string, closed: boolean): FilterableTableProps | null => {
    const program = source.trim()
    if (source.length > 16_000 || !program.startsWith(tableCall) || /[\r\n]/.test(program))
      return null
    if (closed && !program.endsWith(")")) return null

    // ponytail: v1 accepts one literal component, so only the outer rows array needs repairing.
    const argsSource = closed
      ? program.slice(tableCall.length, -1)
      : readFilterableTablePrefix(program.slice(tableCall.length))
    if (argsSource === null) return null

    try {
      // Check the original literals before OpenUI can coerce or repair them.
      const args: unknown[] = JSON.parse(`[${argsSource}${closed ? "" : "]"}]`)
      if (args.length !== 3) return null
      const [title, columns, rows] = args
      const parsed = tableProps.safeParse({ title, columns, rows })
      if (
        !parsed.success ||
        parsed.data.rows.some((row) => row.length !== parsed.data.columns.length)
      )
        return null

      const { root, meta } = parser.set(closed ? program : tableCall + argsSource, closed)
      if (
        root?.typeName !== tableName ||
        root.hasDynamicProps !== false ||
        meta.statementCount !== 1 ||
        meta.errors.length ||
        meta.unresolved.length ||
        (closed && (root.partial || meta.incomplete))
      )
        return null
      return parsed.data
    } catch {
      return null
    }
  }
}
