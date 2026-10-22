import type { ToolDefinition, ToolDiscovery, ToolDiscoveryEntry } from "@vykor/agent-contracts";
import { ToolSearchIndex } from "./tool-search-index.js";

const indexes = new WeakMap<ToolDiscovery, ToolSearchIndex>();

export const toolSearchTool: ToolDefinition = {
  name: "ToolSearch",
  description: "Find authorized tools by task, name or description. Selected tool definitions become available in the next model request; call them after this search returns. Search never grants new permissions.",
  safeToRetry: true,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 500, description: "Task keywords or an exact tool name; Chinese and English supported" },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 5, description: "Maximum tools to expose (default 5)" },
    },
    required: ["query"],
  },
  async execute(input, context) {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    const limit = input.limit ?? 5;
    if (!query || query.length > 500 || typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20) {
      return { content: [{ type: "text", text: "Provide a nonempty query (at most 500 characters) and an integer limit from 1 to 20." }], isError: true, failureKind: "invalid_input", executionState: "not_started" };
    }
    const discovery = context.toolDiscovery;
    const registry = context.toolRegistry;
    if (!discovery && !registry) {
      return {
        content: [{ type: "text", text: "ToolSearch requires the current runtime tool registry." }],
        isError: true,
      };
    }
    const catalog: readonly ToolDiscoveryEntry[] = discovery?.catalog ?? registry!.getAll().map(tool => ({
      name: tool.name, description: tool.description.slice(0, 1000), source: registry!.inspect(tool.name)?.source,
    }));
    const eligible = discovery?.getEligibleNames() ?? new Set(catalog.map(row => row.name));
    let names: string[];
    try {
      let index = discovery && indexes.get(discovery);
      if (!index) {
        index = new ToolSearchIndex(catalog);
        if (discovery) indexes.set(discovery, index);
      }
      names = index.search(query, eligible, limit);
    } catch {
      // Ranking failure must never widen the catalog or bypass current eligibility.
      const lower = query.toLowerCase();
      names = catalog.filter(row => eligible.has(row.name) && (row.name.toLowerCase().includes(lower)
        || row.description.toLowerCase().includes(lower))).slice(0, limit).map(row => row.name);
    }
    const accepted = new Set(discovery ? discovery.expose(names) : names);
    const byName = new Map(catalog.map(row => [row.name, row]));
    const matches = names.filter(name => accepted.has(name)).map(name => byName.get(name)!);
    if (matches.length === 0) {
      return { content: [{ type: "text", text: "(no matches)" }] };
    }
    // Catalog descriptions are untrusted data. Never include schemas or execute handles here.
    const text = JSON.stringify(matches.map(row => ({ name: row.name, description: row.description.slice(0, 1000), source: row.source })));
    return { content: [{ type: "text", text }] };
  },
};
