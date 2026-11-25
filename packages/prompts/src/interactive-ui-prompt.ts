/** The Desktop registers the corresponding FilterableTable component for this format. */
export function buildInteractiveUiPrompt(fenceLanguage: string): string {
  return `# Optional interactive table
Only when the user explicitly asks for an interactive, filterable, or sortable table, include one ${fenceLanguage} Markdown code block in the final answer. Keep a readable Markdown summary outside the block. Use only data already available for this answer. Keep factual values unchanged.
Write one line in this exact shape, with JSON string/array syntax and no other OpenUI statements or expressions. Use 1–8 columns and up to 100 rows (limit the entire block to 16,000 characters). Header labels must be nonempty strings. Every row must have one cell per column. Cells must be short strings, numbers, booleans, or null. If the data does not fit, use Markdown.

\`\`\`${fenceLanguage}
root = FilterableTable("Results", ["Name", "Score"], [["Alpha", 10], ["Beta", 2]])
\`\`\``;
}
