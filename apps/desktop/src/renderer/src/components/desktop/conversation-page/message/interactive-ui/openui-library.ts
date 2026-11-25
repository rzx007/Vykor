import { createParser } from "@openuidev/lang-core"
import { z } from "zod/v4"

const cell = z.union([z.string().max(160), z.number(), z.boolean(), z.null()])
const tableProps = z.object({
  title: z.string().trim().min(1).max(160),
  columns: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
  rows: z.array(z.array(cell).max(8)).max(100),
})

export type FilterableTableProps = z.infer<typeof tableProps>

const tableName = "FilterableTable"
const parser = createParser({
  $defs: { [tableName]: z.toJSONSchema(tableProps) },
  properties: { [tableName]: { $ref: `#/$defs/${tableName}` } },
}, tableName)
const tableCall = `root = ${tableName}(`

export function readInteractiveTable(source: string): FilterableTableProps | null {
  const program = source.trim()
  if (source.length > 16_000 || !program.startsWith(tableCall) || !program.endsWith(")") || /[\r\n]/.test(program)) return null

  // ponytail: v1 accepts a single literal component. Add composition only once a second component needs it.
  // The streaming parser repairs some invalid inputs. Preserve the original literal values here.
  const args: unknown[] = JSON.parse(`[${program.slice(tableCall.length, -1)}]`)
  if (args.length !== 3) return null
  const parsed = tableProps.safeParse({ title: args[0], columns: args[1], rows: args[2] })
  if (!parsed.success || parsed.data.rows.some((row) => row.length !== parsed.data.columns.length)) return null
  const { root, meta } = parser.parse(program)
  if (root?.typeName !== tableName || root.partial || root.hasDynamicProps !== false ||
      meta.statementCount !== 1 || meta.incomplete || meta.errors.length || meta.unresolved.length) return null
  return parsed.data
}
