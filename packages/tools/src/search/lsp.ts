import type { ToolContext, ToolDefinition, ToolResult } from "@vykor/core";

export const lspTool: ToolDefinition = {
  name: "Lsp",
  description: "Code intelligence: symbols, definitions, references, hover.",
  inputSchema: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["document_symbol", "workspace_symbol", "go_to_definition", "find_references", "hover"], description: "Operation" },
      filePath: { type: "string", description: "Source file path" },
      symbol: { type: "string", description: "Symbol name" },
      line: { type: "number", description: "1-based line number" },
      character: { type: "number", description: "1-based character offset" },
      query: { type: "string", description: "Query for workspace_symbol" },
    },
    required: ["operation"],
  },
  async execute(input, context) {
    if (context.environment) return executeEnvironmentLsp(input, context);
    const { LspClient } = await import("@vykor/services");
    const operation = input.operation as string;
    const client = new LspClient({
      command: "",
      args: [],
      cwd: context.cwd,
      sessionId: context.sessionId,
      settings: context.settings,
      signal: context.abortSignal,
    });

    if (operation === "workspace_symbol") {
      const results = await client.workspaceSymbolSearch(context.cwd, (input.query as string) ?? "");
      if (!results.length) return { content: [{ type: "text", text: "(no results)" }] };
      const text = results.map((r) => `${r.kind} ${r.name} - ${r.path}:${r.line}`).join("\n");
      return { content: [{ type: "text", text }] };
    }

    const filePath = input.filePath as string;
    if (!filePath) return { content: [{ type: "text", text: `${operation} requires filePath` }], isError: true };

    const { resolve } = await import("node:path");
    const fullPath = resolve(context.cwd, filePath);

    if (operation === "document_symbol") {
      const results = await client.documentSymbols(fullPath);
      if (!results.length) return { content: [{ type: "text", text: "(no symbols)" }] };
      const text = results.map((r) => `${r.kind} ${r.name} - ${r.path}:${r.line}`).join("\n");
      return { content: [{ type: "text", text }] };
    }

    if (operation === "go_to_definition") {
      const results = await client.goToDefinition(context.cwd, fullPath, input.symbol as string, input.line as number | undefined);
      if (!results.length) return { content: [{ type: "text", text: "(no results)" }] };
      const text = results.map((r) => `${r.kind} ${r.name} - ${r.path}:${r.line}`).join("\n");
      return { content: [{ type: "text", text }] };
    }

    if (operation === "find_references") {
      const results = await client.findReferences(context.cwd, fullPath, input.symbol as string, input.line as number | undefined);
      if (!results.length) return { content: [{ type: "text", text: "(no results)" }] };
      const text = results.map((r) => `${r.path}:${r.line}: ${r.text}`).join("\n");
      return { content: [{ type: "text", text }] };
    }

    if (operation === "hover") {
      const result = await client.hover(context.cwd, fullPath, input.symbol as string, input.line as number, input.character as number);
      if (!result) return { content: [{ type: "text", text: "(no hover result)" }] };
      const parts = [`${result.kind} ${result.name}`, `${result.path}:${result.line}:${result.character}`];
      if (result.signature) parts.push(`signature: ${result.signature}`);
      return { content: [{ type: "text", text: parts.join("\n") }] };
    }

    return { content: [{ type: "text", text: `Unknown operation: ${operation}` }], isError: true };
  },
};

async function executeEnvironmentLsp(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const environment = context.environment!;
  const operation = String(input.operation ?? "");
  const root = environment.workspace.executionRoot;

  if (operation === "workspace_symbol") {
    const query = typeof input.query === "string" ? input.query : "";
    if (!query) return textResult("(no results)");
    const matches = await environment.files.grep(root, query, {
      include: "*.{ts,js,py}",
      caseSensitive: true,
      limit: 20,
    });
    return textResult(matches.length ? matches.map(formatSymbolMatch).join("\n") : "(no results)");
  }

  const rawFilePath = typeof input.filePath === "string" ? input.filePath : "";
  if (!rawFilePath) return errorResult(`${operation} requires filePath`);
  const resolved = await environment.paths.resolve(rawFilePath, "read");

  if (operation === "document_symbol") {
    const content = await environment.files.readText(resolved.executionPath).catch(() => "");
    const symbols = extractSymbols(content, resolved.executionPath);
    return textResult(symbols.length ? symbols.join("\n") : "(no symbols)");
  }
  if (operation === "hover") return textResult("(no hover result)");

  if (operation === "find_references" || operation === "go_to_definition") {
    const symbol = typeof input.symbol === "string" ? input.symbol : "";
    if (!symbol) return textResult("(no results)");
    const matches = await environment.files.grep(root, symbol, {
      include: "*.{ts,js,py}",
      caseSensitive: true,
      limit: 20,
    });
    if (operation === "find_references") {
      return textResult(matches.length ? matches.join("\n") : "(no results)");
    }
    return textResult(matches.length
      ? matches.map((match) => {
          const parsed = parseMatch(match);
          return `definition ${symbol} - ${parsed.path}:${parsed.line}`;
        }).join("\n")
      : "(no results)");
  }

  return errorResult(`Unknown operation: ${operation}`);
}

function extractSymbols(content: string, filePath: string): string[] {
  const symbols: string[] = [];
  const patterns = [
    { regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm, kind: "function" },
    { regex: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm, kind: "class" },
    { regex: /^(?:export\s+)?(?:const|let|var)\s+(\w+)/gm, kind: "variable" },
    { regex: /^(?:export\s+)?interface\s+(\w+)/gm, kind: "interface" },
    { regex: /^(?:export\s+)?type\s+(\w+)/gm, kind: "type" },
    { regex: /^def\s+(\w+)/gm, kind: "function" },
  ];
  for (const { regex, kind } of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content))) {
      symbols.push(`${kind} ${match[1]} - ${filePath}:${content.slice(0, match.index).split("\n").length}`);
    }
  }
  return symbols;
}

function formatSymbolMatch(match: string): string {
  const parsed = parseMatch(match);
  return `match ${parsed.text.trim().slice(0, 80)} - ${parsed.path}:${parsed.line}`;
}

function parseMatch(match: string): { path: string; line: number; text: string } {
  const [path = "", line = "0", ...text] = match.split(":");
  return { path, line: Number.parseInt(line, 10) || 0, text: text.join(":") };
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
