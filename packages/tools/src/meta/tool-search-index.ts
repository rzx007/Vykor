import MiniSearch from "minisearch";
import type { ToolDiscoveryEntry } from "@vykor/core";

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

function tokenize(text: string): string[] {
  const split = text.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return [...new Set([
    ...[...segmenter.segment(split)].filter(part => part.isWordLike).map(part => part.segment.toLowerCase()),
    ...(text.match(/[a-zA-Z\d_][a-zA-Z\d_-]*/g) ?? []).map(part => part.toLowerCase()),
  ])];
}

/** MiniSearch implements BM25+; this class owns only local ranking, never authorization. */
export class ToolSearchIndex {
  private readonly index = new MiniSearch({
    fields: ["name", "description", "source"], idField: "name", tokenize,
    searchOptions: { boost: { name: 3, source: 0.5 }, prefix: true },
  });

  constructor(catalog: readonly ToolDiscoveryEntry[]) {
    this.index.addAll(catalog.map(row => ({ name: row.name, description: row.description.slice(0, 1000),
      source: row.source ? `${row.source.kind} ${row.source.id ?? ""}` : "",
    })));
  }

  search(query: string, eligible: ReadonlySet<string>, limit: number): string[] {
    const exact = query.toLowerCase();
    return this.index.search(query, { filter: result => eligible.has(String(result.id)) })
      .sort((a, b) => Number(String(b.id).toLowerCase() === exact) - Number(String(a.id).toLowerCase() === exact)
        || b.score - a.score || String(a.id).localeCompare(String(b.id), "en"))
      .slice(0, limit).map(result => String(result.id));
  }
}
