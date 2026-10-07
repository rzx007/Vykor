import { join } from "node:path";
import { mkdir, readFile, writeFile, readdir, unlink, rename } from "node:fs/promises";
import { detectCredentialValue } from "./sensitive-content.js";
import {
  DEFAULT_MEMORY_SCOPE,
  DEFAULT_MEMORY_TYPE,
  FRONTMATTER_FIELDS,
  SCHEMA_VERSION,
  coerceInt,
  computeMemorySignature,
  entryToMetadata,
  firstContentLine,
  fromIso,
  metadataToEntry,
  parseMemoryScope,
  parseMemoryType,
  renderMemoryFile,
  splitMemoryFile,
  toIso,
  tokenize,
  truncateEntrypointContent,
  type MemoryAddOptions,
  type MemoryEntry,
  type MemorySearchOptions,
  type MemorySearchResult,
} from "./memory-format.js";

export {
  DEFAULT_MEMORY_SCOPE,
  DEFAULT_MEMORY_TYPE,
  FRONTMATTER_FIELDS,
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
  MEMORY_SCOPES,
  MEMORY_TYPES,
  SCHEMA_VERSION,
  computeMemorySignature,
  firstContentLine,
  normalizeMemoryContent,
  parseFrontmatter,
  parseMemoryScope,
  parseMemoryType,
  renderFrontmatter,
  renderMemoryFile,
  splitMemoryFile,
  tokenize,
  truncateEntrypointContent,
  type EntrypointView,
  type MemoryAddOptions,
  type MemoryEntry,
  type MemoryScope,
  type MemorySearchOptions,
  type MemorySearchResult,
  type MemoryType,
} from "./memory-format.js";

export { detectCredentialValue, type CredentialRisk } from "./sensitive-content.js";

export {
  MAX_MEMORY_EXTRACTION_RECORDS,
  buildMemoryExtractionPrompt,
  isMemoryWriteToolCall,
  parseMemoryExtractionRecords,
  selectWritableMemoryExtractionRecords,
  type MemoryExtractionRecord,
} from "./extraction.js";

const METADATA_WEIGHT = 2;
const CONTENT_WEIGHT = 1;

const RECENCY_DAY_MS = 86_400_000;

export class MemoryManager {
  private entries = new Map<string, MemoryEntry>();
  private maxEntries: number;
  private storageDir: string | undefined;
  private loaded = false;
  /** 写串行队列：所有持久化操作链在同一 Promise 上，防止并发写入撕裂文件。 */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(maxEntries = 1000, storageDir?: string) {
    this.maxEntries = maxEntries;
    this.storageDir = storageDir && storageDir.length > 0 ? storageDir : undefined;
  }

  /**
   * 将 fn 排入写队列串行执行，返回该次写入的 Promise。
   * 队列尾部始终是 settled 的 Promise（不带 rejection），
   * 保证即使某次写失败也不会卡死后续写入。
   */
  private enqueueWrite(fn: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(fn, fn);
    this.writeQueue = next.then(() => {}, () => {});
    return next;
  }

  async add(
    content: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    options?: MemoryAddOptions,
  ): Promise<MemoryEntry> {
    await this.ensureLoaded();

    if (!content.trim()) {
      throw new Error("Memory content must not be empty");
    }
    if (containsCredentialLikeValue([content, ...(tags ?? []), options?.name, options?.description], metadata)) {
      throw new Error("Memory contains credential-like content");
    }

    const type = options?.type ?? DEFAULT_MEMORY_TYPE;
    const scope = options?.scope ?? DEFAULT_MEMORY_SCOPE;
    const signature = computeMemorySignature(content, type, "knowledge");

    // Signature dedup: if identical content already exists, return it instead
    // of writing a duplicate file.
    for (const existing of this.entries.values()) {
      if (existing.signature === signature && existing.scope === scope && existing.metadata?.disabled !== true) {
        if (!existing.metadata?.source_type && typeof metadata?.source_type === "string") {
          const sourceFields = Object.fromEntries(
            ["source_type", "source_session_id", "source_message_sha256"]
              .filter((key) => typeof metadata[key] === "string")
              .map((key) => [key, metadata[key]]),
          );
          await this.update(existing.id, { metadata: { ...existing.metadata, ...sourceFields } });
        }
        return existing;
      }
    }

    const id = this.generateId();
    const now = Date.now();
    const entry: MemoryEntry = {
      id,
      content,
      tags,
      createdAt: now,
      updatedAt: now,
      metadata,
      name: options?.name?.trim() || firstContentLine(content) || content.trim().slice(0, 200),
      description: options?.description?.trim() || firstContentLine(content) || content.trim().slice(0, 200),
      type,
      scope,
      importance: options?.importance ?? 0,
      signature,
      useCount: 0,
    };
    this.entries.set(id, entry);
    this.evictIfNeeded();

    if (this.storageDir) {
      const snapshot = { ...entry };
      await this.enqueueWrite(async () => {
        await this.persistEntry(snapshot);
        await this.writeIndex();
      });
    }

    return entry;
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    await this.ensureLoaded();
    return this.entries.get(id);
  }

  async update(
    id: string,
    updates: Partial<
      Pick<
        MemoryEntry,
        | "content"
        | "tags"
        | "metadata"
        | "name"
        | "description"
        | "type"
        | "scope"
        | "importance"
      >
    >,
  ): Promise<MemoryEntry | undefined> {
    await this.ensureLoaded();
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (containsCredentialLikeValue([
      updates.content, ...(updates.tags ?? []), updates.name, updates.description,
    ], updates.metadata)) {
      throw new Error("Memory contains credential-like content");
    }
    if (updates.content !== undefined) entry.content = updates.content;
    if (updates.tags !== undefined) entry.tags = updates.tags;
    if (updates.metadata !== undefined) entry.metadata = updates.metadata;
    if (updates.name !== undefined) entry.name = updates.name.trim() || firstContentLine(entry.content) || entry.content.trim().slice(0, 200);
    if (updates.description !== undefined) entry.description = updates.description.trim() || firstContentLine(entry.content) || entry.content.trim().slice(0, 200);
    if (updates.type !== undefined) entry.type = updates.type;
    if (updates.scope !== undefined) entry.scope = updates.scope;
    if (updates.importance !== undefined) entry.importance = updates.importance;
    entry.updatedAt = Date.now();
    if (updates.content !== undefined) {
      entry.signature = computeMemorySignature(
        entry.content,
        entry.type ?? DEFAULT_MEMORY_TYPE,
        "knowledge",
      );
    }

    if (this.storageDir) {
      const snapshot = { ...entry };
      await this.enqueueWrite(async () => {
        await this.persistEntry(snapshot);
        await this.writeIndex();
      });
    }

    return entry;
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const deleted = this.entries.delete(id);
    if (deleted && this.storageDir) {
      const deletedId = id;
      await this.enqueueWrite(async () => {
        await this.removeEntryFile(deletedId);
        await this.writeIndex();
      });
    }
    return deleted;
  }

  /** Record that a memory entry was recalled, bumping use_count/last_used_at. */
  async markMemoryUsed(ids: string | string[]): Promise<void> {
    await this.ensureLoaded();
    const list = Array.isArray(ids) ? ids : [ids];
    const activeIds = new Set(this.activeEntries().map((entry) => entry.id));
    const now = Date.now();
    const touched: MemoryEntry[] = [];
    for (const id of list) {
      const entry = this.entries.get(id);
      if (!entry || !activeIds.has(id)) continue;
      entry.useCount = (entry.useCount ?? 0) + 1;
      entry.lastUsedAt = now;
      touched.push(entry);
    }
    if (this.storageDir) {
      const snapshots = touched.map((e) => ({ ...e }));
      await this.enqueueWrite(async () => {
        for (const s of snapshots) await this.persistEntry(s);
      });
    }
  }

  /**
   * Return low-value unused memories (stale candidates) for pruning review.
   * Mirrors Python `find_stale_memory_candidates`.
   */
  async findStaleCandidates(
    staleDays = 60,
    maxImportance = 1,
  ): Promise<MemoryEntry[]> {
    await this.ensureLoaded();
    const now = Date.now();
    const candidates: MemoryEntry[] = [];
    for (const entry of this.activeEntries()) {
      if ((entry.importance ?? 0) > maxImportance) continue;
      if ((entry.useCount ?? 0) > 0) continue;
      const base = entry.updatedAt ?? entry.createdAt;
      if (now - base >= staleDays * RECENCY_DAY_MS) {
        candidates.push(entry);
      }
    }
    candidates.sort(
      (a, b) =>
        (a.importance ?? 0) - (b.importance ?? 0) ||
        (a.updatedAt ?? 0) - (b.updatedAt ?? 0),
    );
    return candidates;
  }

  async search(options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    await this.ensureLoaded();
    const { query, tags, limit = 10 } = options;
    const queryTerms = tokenize(query);
    const results: MemorySearchResult[] = [];

    for (const entry of this.activeEntries()) {
      if (tags?.length && !tags.some((t) => entry.tags?.includes(t))) {
        continue;
      }
      const score = this.computeScore(entry, queryTerms);
      if (score > 0) {
        results.push({ entry, score });
      }
    }

    results.sort(
      (a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt,
    );
    return results.slice(0, limit);
  }

  async getAll(): Promise<readonly MemoryEntry[]> {
    await this.ensureLoaded();
    return [...this.entries.values()];
  }

  async getActive(): Promise<readonly MemoryEntry[]> {
    await this.ensureLoaded();
    return this.activeEntries();
  }

  async reload(): Promise<void> {
    if (!this.storageDir) return;
    await this.writeQueue;
    this.entries.clear();
    this.loaded = false;
    await this.ensureLoaded();
  }

  async clear(): Promise<void> {
    this.entries.clear();
    this.loaded = true;
    if (this.storageDir) {
      try {
        const files = await readdir(this.storageDir);
        for (const file of files) {
          if (file.endsWith(".md") && file !== "MEMORY.md") {
            await unlink(join(this.storageDir, file));
          }
        }
        await this.writeIndex();
      } catch {
        // directory may not exist
      }
    }
  }

  count(): number {
    return this.entries.size;
  }

  buildMemoryPrompt(maxEntries = 10, query?: string): string {
    return this.selectRelevantForPrompt(maxEntries, query).text;
  }

  /**
   * Select the same batch of entries {@link buildMemoryPrompt} would render and
   * return both the rendered prompt text and the chosen entries (and their
   * ids). Callers can inject `text` and feed the *same* `ids` to
   * {@link markMemoryUsed}, guaranteeing use_count feedback tracks exactly what
   * was injected (mirrors Python `select_relevant_memories` +
   * `mark_memory_used`). When nothing is selected, `text` is `""` and
   * `entries`/`ids` are empty.
   *
   * The selection (filter + sort + truncation) is identical to
   * {@link buildMemoryPrompt}; both share this method.
   */
  selectRelevantForPrompt(
    maxEntries = 10,
    query?: string,
  ): { text: string; entries: MemoryEntry[]; ids: string[] } {
    const entries = this.selectPromptEntries(maxEntries, query);
    if (!entries.length) return { text: "", entries: [], ids: [] };
    const lines = ["<memory>", "Relevant memories from previous interactions:"];
    for (const entry of entries) {
      const tags = entry.tags?.length ? ` [${entry.tags.join(", ")}]` : "";
      const age = this.freshnessNote(entry);
      lines.push(`- ${entry.content}${tags}${age}`);
    }
    lines.push("</memory>");
    return {
      text: lines.join("\n"),
      entries,
      ids: entries.map((e) => e.id),
    };
  }

  /** Shared filter + sort + truncation used by the prompt builders. */
  private selectPromptEntries(maxEntries: number, query?: string): MemoryEntry[] {
    if (query) {
      // Relevance-ordered selection when a query is supplied.
      const terms = tokenize(query);
      return this.activeEntries()
        .map((e) => ({ e, s: this.computeScore(e, terms) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || b.e.updatedAt - a.e.updatedAt)
        .slice(0, maxEntries)
        .map((x) => x.e);
    }
    return this.activeEntries()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, maxEntries);
  }

  private activeEntries(): MemoryEntry[] {
    const enabled = [...this.entries.values()].filter((entry) =>
      entry.metadata?.disabled !== true && !containsCredentialLikeValue([
        entry.content, entry.name, entry.description, ...(entry.tags ?? []),
      ], entry.metadata));
    const superseded = new Set<string>();
    for (const entry of enabled) {
      const raw = entry.metadata?.supersedes;
      const ids = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
      for (const id of ids) if (typeof id === "string") superseded.add(id);
    }
    return enabled.filter((entry) => !superseded.has(entry.id));
  }

  // ── scoring ──────────────────────────────────────────────

  private computeScore(entry: MemoryEntry, queryTerms: string[]): number {
    // Frontmatter (name/description/tags/metadata) weighted higher than body,
    // plus importance, use_count and recency factors (mirrors Python
    // search.py). Each query token counts as *at most one* distinct hit per
    // bucket — presence, not occurrence count — so high-frequency repeated
    // words are not artificially amplified (aligns with Python's
    // `sum(1 for t in tokens if t in meta/body)`).
    const metaText = `${entry.name ?? ""} ${entry.description ?? ""}`.toLowerCase();
    const bodyLower = entry.content.toLowerCase();
    // Fold metadata JSON and tags into the same "meta" surface the Python
    // implementation derives from title/description, then dedupe per token.
    const metadataText = entry.metadata
      ? JSON.stringify(entry.metadata).toLowerCase()
      : "";
    const tagsText = entry.tags?.length
      ? entry.tags.join(" ").toLowerCase()
      : "";

    let metaHits = 0;
    let bodyHits = 0;

    for (const term of queryTerms) {
      // distinct meta hit: token present in name/description, metadata, or tags
      if (
        metaText.includes(term) ||
        (metadataText && metadataText.includes(term)) ||
        (tagsText && tagsText.includes(term))
      ) {
        metaHits += 1;
      }
      // distinct body hit: token present in body content (once, regardless of
      // how many times it repeats)
      if (bodyLower.includes(term)) bodyHits += CONTENT_WEIGHT;
    }

    if (metaHits === 0 && bodyHits === 0) return 0;

    const score =
      metaHits * METADATA_WEIGHT +
      bodyHits +
      (entry.importance ?? 0) * 0.4 +
      Math.min(entry.useCount ?? 0, 5) * 0.1 +
      this.recencyBoost(entry);
    return score;
  }

  private recencyBoost(entry: MemoryEntry): number {
    const ts = entry.updatedAt ?? entry.createdAt;
    if (!ts) return 0;
    const ageDays = (Date.now() - ts) / RECENCY_DAY_MS;
    if (ageDays <= 14) return 0.3;
    if (ageDays <= 30) return 0.1;
    return 0;
  }

  private freshnessNote(entry: MemoryEntry): string {
    const ts = entry.updatedAt ?? entry.createdAt;
    if (!ts) return "";
    const days = Math.floor((Date.now() - ts) / RECENCY_DAY_MS);
    if (days <= 1) return "";
    return ` (memory is ${days} days old; verify before relying on it)`;
  }

  // ── persistence ──────────────────────────────────────────

  private generateId(): string {
    return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries.values()].sort(
        (a, b) => a.createdAt - b.createdAt,
      )[0];
      if (oldest) {
        this.entries.delete(oldest.id);
        if (this.storageDir) void this.removeEntryFile(oldest.id);
      } else break;
    }
  }

  private async persistEntry(entry: MemoryEntry): Promise<void> {
    if (!this.storageDir) return;
    await mkdir(this.storageDir, { recursive: true });
    const filePath = join(this.storageDir, `${entry.id}.md`);
    const rendered = renderMemoryFile(entryToMetadata(entry), entry.content);
    const temporary = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(temporary, rendered, "utf-8");
      await rename(temporary, filePath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  private async removeEntryFile(id: string): Promise<void> {
    if (!this.storageDir) return;
    try {
      await unlink(join(this.storageDir, `${id}.md`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded || !this.storageDir) {
      this.loaded = true;
      return;
    }
    this.loaded = true;
    let files: string[];
    try {
      files = await readdir(this.storageDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const file of files) {
        if (!file.endsWith(".md") || file === "MEMORY.md") continue;
        const path = join(this.storageDir, file);
        const raw = await readFile(path, "utf-8");
        const { metadata, body } = splitMemoryFile(raw);
        const entry = metadataToEntry(metadata, body);
        const fileId = file.replace(/\.md$/, "");
        if (entry.id !== fileId) {
          throw new Error(`Memory id ${entry.id} does not match filename ${file}`);
        }
        if (!entry.signature) {
          entry.signature = computeMemorySignature(
            entry.content,
            entry.type ?? DEFAULT_MEMORY_TYPE,
            "knowledge",
          );
        }
        this.entries.set(entry.id, entry);
    }
  }

  /** Maintain the MEMORY.md index (one pointer line per memory, truncated). */
  private async writeIndex(): Promise<void> {
    if (!this.storageDir) return;
    const entries = this.activeEntries().sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    const lines: string[] = ["# Memory", ""];
    for (const entry of entries) {
      const desc =
        entry.description ||
        entry.name ||
        firstContentLine(entry.content) ||
        entry.content.slice(0, 80);
      lines.push(`- [${entry.id}] ${desc}`);
    }
    const raw = lines.join("\n") + "\n";
    const view = truncateEntrypointContent(raw);
    try {
      await mkdir(this.storageDir, { recursive: true });
      await writeFile(join(this.storageDir, "MEMORY.md"), view.content, "utf-8");
    } catch {
      // best-effort
    }
  }
}

function containsCredentialLikeValue(
  values: Array<string | undefined>,
  metadata?: Record<string, unknown>,
): boolean {
  if (values.some((value) => value && detectCredentialValue(value))) return true;
  return Object.entries(metadata ?? {}).some(([key, value]) =>
    typeof value === "string" && Boolean(detectCredentialValue(`${key}=${value}`)));
}
