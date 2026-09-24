import type { ToolDefinition } from "@vykor/core";

export const notebookEditTool: ToolDefinition = {
  name: "NotebookEdit",
  description: "Create or edit a Jupyter notebook cell.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the .ipynb file" },
      cellIndex: { type: "number", description: "Zero-based cell index", minimum: 0 },
      newSource: { type: "string", description: "Replacement or appended source" },
      cellType: { type: "string", enum: ["code", "markdown"], default: "code" },
      mode: { type: "string", enum: ["replace", "append"], default: "replace" },
      createIfMissing: { type: "boolean", default: true },
    },
    required: ["path", "cellIndex", "newSource"],
  },
  async execute(input, context) {
    const { readFile, writeFile, mkdir } = await import("node:fs/promises");
    const { resolve, dirname } = await import("node:path");

    const filePath = resolve(context.cwd, input.path as string);
    const cellIndex = input.cellIndex as number;
    const newSource = input.newSource as string;
    const cellType = (input.cellType as string) ?? "code";
    const mode = (input.mode as string) ?? "replace";
    const createIfMissing = (input.createIfMissing as boolean) ?? true;

    let notebook: Record<string, any>;
    try {
      const raw = await readFile(filePath, "utf-8");
      notebook = JSON.parse(raw);
    } catch {
      if (!createIfMissing) {
        return { content: [{ type: "text", text: `Notebook not found: ${filePath}` }], isError: true };
      }
      notebook = { cells: [], metadata: { language_info: { name: "python" } }, nbformat: 4, nbformat_minor: 5 };
    }

    const cells = notebook.cells ?? [];
    while (cells.length <= cellIndex) {
      cells.push({ cell_type: "code", metadata: {}, source: "", outputs: [], execution_count: null });
    }

    const cell = cells[cellIndex]!;
    cell.cell_type = cellType;
    cell.metadata = cell.metadata ?? {};
    if (cellType === "code") {
      cell.outputs = cell.outputs ?? [];
      cell.execution_count = cell.execution_count ?? null;
    }

    const existing = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source ?? "");
    cell.source = mode === "replace" ? newSource : existing + newSource;

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(notebook, null, 2) + "\n", "utf-8");
    return { content: [{ type: "text", text: `Updated notebook cell ${cellIndex} in ${filePath}` }] };
  },
};
