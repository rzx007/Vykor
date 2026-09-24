import type { ToolDefinition } from "@vykor/core";

export const todoWriteTool: ToolDefinition = {
  name: "TodoWrite",
  description: "Append a TODO item to a markdown checklist file.",
  inputSchema: {
    type: "object",
    properties: {
      item: { type: "string", description: "TODO item text" },
      checked: { type: "boolean", description: "Whether the item is checked", default: false },
      path: { type: "string", description: "File path", default: "TODO.md" },
    },
    required: ["item"],
  },
  async execute(input, context) {
    const { readFile, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const item = input.item as string;
    const checked = (input.checked as boolean) ?? false;
    const filePath = join(context.cwd, (input.path as string) ?? "TODO.md");
    const prefix = checked ? "- [x]" : "- [ ]";
    let existing = "# TODO\n";
    try {
      existing = await readFile(filePath, "utf-8");
    } catch {}
    const updated = existing.trimEnd() + `\n${prefix} ${item}\n`;
    await writeFile(filePath, updated, "utf-8");
    return { content: [{ type: "text", text: `Updated ${filePath}` }] };
  },
};
