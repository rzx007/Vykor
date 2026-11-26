const jsonString = /"(?:[^"\\]|\\.)*"/.source
const flatArray = String.raw`\[(?:${jsonString}|[^"[\]\\])*\]`
const heading = new RegExp(String.raw`^\s*${jsonString}\s*,\s*${flatArray}`)
const rowList = new RegExp(String.raw`^,\s*\[\s*(${flatArray}(?:\s*,\s*${flatArray})*)?`)

/** Keep the title, columns and rows whose closing brackets are present in the source. */
export function readFilterableTablePrefix(source: string): string | null {
  const header = heading.exec(source)?.[0]
  if (!header) return null

  const rest = source.slice(header.length).trimStart()
  // The header can display before the model opens the rows array.
  if (!rest || rest === ",") return header + ", ["
  const rows = rowList.exec(rest)
  return rows ? `${header}, [${rows[1] ?? ""}` : null
}
