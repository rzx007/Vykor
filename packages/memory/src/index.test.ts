import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryManager,
  tokenize,
  splitMemoryFile,
  renderMemoryFile,
  renderFrontmatter,
  parseFrontmatter,
  computeMemorySignature,
} from "../src/index.js";

describe("MemoryManager", () => {
  it("adds and retrieves an entry", async () => {
    const mgr = new MemoryManager();
    const entry = await mgr.add("hello world", ["greeting"]);
    expect(entry.content).toBe("hello world");
    expect(entry.tags).toEqual(["greeting"]);
    const found = await mgr.get(entry.id);
    expect(found).toBeDefined();
    expect(found!.content).toBe("hello world");
  });

  it("rejects empty content instead of writing an unreadable memory", async () => {
    const mgr = new MemoryManager();
    await expect(mgr.add("  \n  ")).rejects.toThrow("Memory content must not be empty");
  });

  it("returns undefined for nonexistent entry", async () => {
    const mgr = new MemoryManager();
    expect(await mgr.get("nope")).toBeUndefined();
  });

  it("updates an entry", async () => {
    const mgr = new MemoryManager();
    const entry = await mgr.add("original");
    const updated = await mgr.update(entry.id, { content: "updated", tags: ["new"] });
    expect(updated!.content).toBe("updated");
    expect(updated!.tags).toEqual(["new"]);
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(entry.createdAt);
  });

  it("update returns undefined for nonexistent entry", async () => {
    const mgr = new MemoryManager();
    expect(await mgr.update("nope", { content: "x" })).toBeUndefined();
  });

  it("deletes an entry", async () => {
    const mgr = new MemoryManager();
    const entry = await mgr.add("to delete");
    expect(await mgr.delete(entry.id)).toBe(true);
    expect(await mgr.get(entry.id)).toBeUndefined();
  });

  it("searches by content substring", async () => {
    const mgr = new MemoryManager();
    await mgr.add("hello world");
    await mgr.add("hello universe");
    await mgr.add("goodbye world");
    const results = await mgr.search({ query: "hello" });
    expect(results).toHaveLength(2);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("search filters by tags", async () => {
    const mgr = new MemoryManager();
    await mgr.add("alpha doc", ["docs"]);
    await mgr.add("beta doc", ["docs"]);
    await mgr.add("alpha code", ["code"]);
    const results = await mgr.search({ query: "alpha", tags: ["docs"] });
    expect(results).toHaveLength(1);
    expect(results[0].entry.content).toBe("alpha doc");
  });

  it("search respects limit", async () => {
    const mgr = new MemoryManager();
    for (let i = 0; i < 10; i++) {
      await mgr.add(`item ${i} hello`);
    }
    const results = await mgr.search({ query: "hello", limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("getAll returns all entries", async () => {
    const mgr = new MemoryManager();
    await mgr.add("a");
    await mgr.add("b");
    expect((await mgr.getAll()).length).toBe(2);
  });

  it("clear removes all entries", async () => {
    const mgr = new MemoryManager();
    await mgr.add("a");
    await mgr.add("b");
    await mgr.clear();
    expect(mgr.count()).toBe(0);
  });

  it("evicts oldest entries when max exceeded", async () => {
    const mgr = new MemoryManager(3);
    const e1 = await mgr.add("first");
    await mgr.add("second");
    await mgr.add("third");
    await mgr.add("fourth");
    expect(mgr.count()).toBe(3);
    expect(await mgr.get(e1.id)).toBeUndefined();
  });
});

describe("tokenize", () => {
  it("keeps ASCII words of length >= 3 and lowercases them", () => {
    expect(tokenize("Hello World").sort()).toEqual(["hello", "world"]);
  });

  it("drops ASCII words shorter than 3 chars", () => {
    expect(tokenize("a an the cat")).toEqual(["the", "cat"]);
  });

  it("splits each CJK ideograph into its own token", () => {
    expect(tokenize("数据库").sort()).toEqual(["数", "据", "库"].sort());
  });

  it("mixes ASCII words and CJK characters", () => {
    const tokens = tokenize("redis 缓存 cfg");
    expect(tokens).toContain("redis");
    expect(tokens).toContain("cfg");
    expect(tokens).toContain("缓");
    expect(tokens).toContain("存");
    expect(tokens).toHaveLength(4);
  });

  it("de-duplicates repeated tokens", () => {
    expect(tokenize("cat cat 猫 猫").sort()).toEqual(["cat", "猫"]);
  });
});

describe("MemoryManager search tokenization", () => {
  it("matches a memory containing the queried Chinese text", async () => {
    const mgr = new MemoryManager();
    await mgr.add("用户偏好使用中文回复");
    await mgr.add("user prefers english responses");
    const results = await mgr.search({ query: "中文" });
    expect(results).toHaveLength(1);
    expect(results[0].entry.content).toBe("用户偏好使用中文回复");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("matches a full Chinese sentence query against partial overlap", async () => {
    const mgr = new MemoryManager();
    await mgr.add("项目使用 pnpm 管理依赖");
    await mgr.add("无关记忆");
    const results = await mgr.search({ query: "依赖管理" });
    expect(results).toHaveLength(1);
    expect(results[0].entry.content).toBe("项目使用 pnpm 管理依赖");
  });

  it("still matches English word queries", async () => {
    const mgr = new MemoryManager();
    await mgr.add("hello world");
    await mgr.add("goodbye world");
    const results = await mgr.search({ query: "hello" });
    expect(results).toHaveLength(1);
    expect(results[0].entry.content).toBe("hello world");
  });

  it("matches body content, not just metadata", async () => {
    const mgr = new MemoryManager();
    await mgr.add("deployment runs on kubernetes cluster");
    const results = await mgr.search({ query: "kubernetes" });
    expect(results).toHaveLength(1);
    expect(results[0].entry.content).toContain("kubernetes");
  });

  it("scores body by distinct token presence, not occurrence count", async () => {
    const mgr = new MemoryManager();
    // `repeated` has the single query token "cache" repeated many times but
    // matches only one distinct query token.
    const repeated = await mgr.add("cache cache cache cache cache cache");
    // `distinct` matches two distinct query tokens once each.
    const distinct = await mgr.add("cache redis");
    const results = await mgr.search({ query: "cache redis" });
    const rep = results.find((r) => r.entry.id === repeated.id)!;
    const dis = results.find((r) => r.entry.id === distinct.id)!;
    // The memory hitting more distinct tokens must outrank the one that only
    // repeats a single token. Under the old occurrence-counting logic the
    // 6x-repeated memory would have won.
    expect(dis.score).toBeGreaterThan(rep.score);
    expect(results[0].entry.id).toBe(distinct.id);
  });

  it("does not amplify a memory just because a token repeats", async () => {
    const mgr = new MemoryManager();
    // Same single distinct-token hit ("redis"), but one repeats it heavily.
    const once = await mgr.add("redis notes");
    const many = await mgr.add("redis redis redis redis redis notes");
    const results = await mgr.search({ query: "redis" });
    const rOnce = results.find((r) => r.entry.id === once.id)!;
    const rMany = results.find((r) => r.entry.id === many.id)!;
    // Both hit the same distinct token; repetition alone must not raise the
    // body contribution (scores equal modulo recency/importance, which are
    // identical here).
    expect(rMany.score).toBe(rOnce.score);
  });

  it("counts a metadata/tag token as a single distinct meta hit", async () => {
    const mgr = new MemoryManager();
    // Token "redis" appears in body, AND in tags + metadata. Name/description
    // are set to text that does not contain the token so the only meta surface
    // is tags+metadata.
    const a = await mgr.add("uses redis here", ["redis"], { topic: "redis" }, {
      name: "alpha note",
      description: "alpha description",
    });
    // Token "redis" appears in body only (name/description/tags/metadata have
    // no overlap). Distinct content so signature dedup does not merge it.
    const b = await mgr.add("uses redis too", undefined, undefined, {
      name: "beta note",
      description: "beta description",
    });
    const results = await mgr.search({ query: "redis" });
    const ra = results.find((r) => r.entry.id === a.id)!;
    const rb = results.find((r) => r.entry.id === b.id)!;
    // `a` gets exactly +1 distinct meta hit (METADATA_WEIGHT = 2) over `b`; the
    // meta hit is counted once, not double-counted across tags AND metadata.
    expect(ra.score - rb.score).toBeCloseTo(2, 5);
  });

  it("weights metadata matches higher than body matches", async () => {
    const mgr = new MemoryManager();
    // bodyMatch: term only in body, with a description that does not contain it.
    const bodyMatch = await mgr.add("see notes mentioning apple here", undefined, undefined, {
      name: "general note",
      description: "general notes",
    });
    // metaMatch: term in the structured name/description (frontmatter), and
    // also once in the body so its body contribution matches bodyMatch's.
    const metaMatch = await mgr.add("apple unrelated content", undefined, undefined, {
      name: "apple preferences",
      description: "apple related context",
    });
    const results = await mgr.search({ query: "apple" });
    expect(results).toHaveLength(2);
    const meta = results.find((r) => r.entry.id === metaMatch.id)!;
    const body = results.find((r) => r.entry.id === bodyMatch.id)!;
    expect(meta.score).toBeGreaterThan(body.score);
  });
});

describe("frontmatter parse/render round-trip", () => {
  it("renders fields in stable order and parses back", () => {
    const meta = {
      schema_version: 1,
      id: "mem-1",
      name: "test note",
      description: "a description",
      type: "project",
      scope: "project",
      importance: 2,
      signature: "abc123",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      use_count: 3,
      tags: ["one", "two"],
    };
    const file = renderMemoryFile(meta, "body line one\nbody line two");
    expect(file.startsWith("---\n")).toBe(true);
    // field order: schema_version must come before id, etc.
    const fmText = file.slice(4, file.indexOf("\n---", 4));
    expect(fmText.indexOf("schema_version")).toBeLessThan(fmText.indexOf("id:"));
    expect(fmText.indexOf("name:")).toBeLessThan(fmText.indexOf("description:"));

    const { metadata, body } = splitMemoryFile(file);
    expect(metadata.id).toBe("mem-1");
    expect(metadata.name).toBe("test note");
    expect(metadata.importance).toBe(2);
    expect(metadata.use_count).toBe(3);
    expect(metadata.tags).toEqual(["one", "two"]);
    expect(body.trim()).toBe("body line one\nbody line two");
  });

  it("handles content with no frontmatter", () => {
    const { metadata, body, hasClosedFrontmatter } = splitMemoryFile("just text\n");
    expect(metadata).toEqual({});
    expect(body).toBe("just text\n");
    expect(hasClosedFrontmatter).toBe(false);
  });

  it("parses CJK string values losslessly", () => {
    const fm = renderFrontmatter({ name: "中文笔记", tags: ["缓存"] });
    const parsed = parseFrontmatter(fm);
    expect(parsed.name).toBe("中文笔记");
    expect(parsed.tags).toEqual(["缓存"]);
  });
});

describe("computeMemorySignature", () => {
  it("is stable across whitespace/case/punctuation differences", () => {
    const a = computeMemorySignature("Hello,  World!", "project", "knowledge");
    const b = computeMemorySignature("hello world", "project", "knowledge");
    expect(a).toBe(b);
  });

  it("differs for different content", () => {
    const a = computeMemorySignature("alpha", "project", "knowledge");
    const b = computeMemorySignature("beta", "project", "knowledge");
    expect(a).not.toBe(b);
  });
});

describe("MemoryManager weighted factors", () => {
  it("ranks higher-importance memory above an equal-text one", async () => {
    const mgr = new MemoryManager();
    const low = await mgr.add("kubernetes deploy notes", undefined, undefined, {
      importance: 0,
    });
    const high = await mgr.add("kubernetes deploy guide", undefined, undefined, {
      importance: 5,
    });
    const results = await mgr.search({ query: "kubernetes" });
    const hi = results.find((r) => r.entry.id === high.id)!;
    const lo = results.find((r) => r.entry.id === low.id)!;
    expect(hi.score).toBeGreaterThan(lo.score);
  });

  it("use_count boosts ranking via markMemoryUsed", async () => {
    const mgr = new MemoryManager();
    const a = await mgr.add("redis cache config alpha");
    const b = await mgr.add("redis cache config beta");
    await mgr.markMemoryUsed(b.id);
    await mgr.markMemoryUsed(b.id);
    const results = await mgr.search({ query: "redis" });
    const rb = results.find((r) => r.entry.id === b.id)!;
    const ra = results.find((r) => r.entry.id === a.id)!;
    expect(rb.score).toBeGreaterThan(ra.score);
    expect((await mgr.get(b.id))!.useCount).toBe(2);
  });
});

describe("MemoryManager selectRelevantForPrompt", () => {
  it("returns entries that exactly match what is rendered into text", async () => {
    const mgr = new MemoryManager();
    const a = await mgr.add("redis cache config alpha");
    const b = await mgr.add("postgres index notes");
    const c = await mgr.add("redis pubsub channel beta");

    const { text, entries, ids } = mgr.selectRelevantForPrompt(10, "redis");
    // Only redis-matching entries selected; postgres excluded.
    expect([...ids].sort()).toEqual([a.id, c.id].sort());
    expect(ids).not.toContain(b.id);
    // ids derive from entries.
    expect(ids).toEqual(entries.map((e) => e.id));
    // Every selected entry's content appears in the rendered text; the
    // excluded one does not.
    for (const e of entries) {
      expect(text).toContain(e.content);
    }
    expect(text).not.toContain("postgres index notes");
  });

  it("matches buildMemoryPrompt text and selection (query + no-query)", async () => {
    const mgr = new MemoryManager();
    await mgr.add("alpha kubernetes deploy");
    await mgr.add("beta kubernetes scale");
    await mgr.add("gamma unrelated note");

    // With a query.
    const sel = mgr.selectRelevantForPrompt(10, "kubernetes");
    expect(sel.text).toBe(mgr.buildMemoryPrompt(10, "kubernetes"));

    // Without a query (recency order).
    const selAll = mgr.selectRelevantForPrompt(10);
    expect(selAll.text).toBe(mgr.buildMemoryPrompt(10));
    expect(selAll.ids).toEqual(selAll.entries.map((e) => e.id));
  });

  it("respects ordering and truncation identical to buildMemoryPrompt", async () => {
    const mgr = new MemoryManager();
    await mgr.add("redis one");
    await mgr.add("redis two");
    await mgr.add("redis three");

    const sel = mgr.selectRelevantForPrompt(2, "redis");
    // Truncated to maxEntries.
    expect(sel.entries.length).toBe(2);
    expect(sel.ids.length).toBe(2);
    // Same selection/order as the legacy prompt builder.
    expect(sel.text).toBe(mgr.buildMemoryPrompt(2, "redis"));
  });

  it("returns empty text/entries/ids when nothing matches", async () => {
    const mgr = new MemoryManager();
    await mgr.add("redis cache config");
    const sel = mgr.selectRelevantForPrompt(10, "nonexistentxyz");
    expect(sel.text).toBe("");
    expect(sel.entries).toEqual([]);
    expect(sel.ids).toEqual([]);
  });
});

describe("MemoryManager Markdown store", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("persists a memory as a .md file with frontmatter and reloads it", async () => {
    dir = await mkdtemp(join(tmpdir(), "ohmem-"));
    const mgr = new MemoryManager(1000, dir);
    const entry = await mgr.add("project uses pnpm workspaces", ["build"], undefined, {
      name: "build tooling",
      importance: 3,
    });

    const files = await readdir(dir);
    expect(files).toContain(`${entry.id}.md`);
    const raw = await readFile(join(dir, `${entry.id}.md`), "utf-8");
    expect(raw.startsWith("---\n")).toBe(true);
    expect(raw).toContain("type:");
    expect(raw).toContain("project uses pnpm workspaces");

    // Fresh manager loads it from disk.
    const mgr2 = new MemoryManager(1000, dir);
    const loaded = await mgr2.get(entry.id);
    expect(loaded).toBeDefined();
    expect(loaded!.content).toBe("project uses pnpm workspaces");
    expect(loaded!.importance).toBe(3);
    expect(loaded!.name).toBe("build tooling");
    const results = await mgr2.search({ query: "pnpm" });
    expect(results.length).toBe(1);
  });

  it("rejects credential-like additions and updates without changing the stored record", async () => {
    const manager = new MemoryManager();
    const entry = await manager.add("Store credentials in environment variables");

    await expect(manager.add("api_key=example-secret-value")).rejects.toThrow("Memory contains credential-like content");
    await expect(manager.add("Safe body", [], { token: "example-secret-value" })).rejects.toThrow("Memory contains credential-like content");
    await expect(manager.update(entry.id, { content: "Bearer exampletoken123456" })).rejects.toThrow("Memory contains credential-like content");
    expect((await manager.get(entry.id))?.content).toBe("Store credentials in environment variables");
    expect((await manager.getAll())).toHaveLength(1);
  });

  it("keeps disabled memories inspectable but out of search, prompts, and the index", async () => {
    dir = await mkdtemp(join(tmpdir(), "vk-memory-disabled-"));
    const manager = new MemoryManager(1000, dir);
    const retired = await manager.add("The old deployment region is west");
    await manager.update(retired.id, { metadata: { disabled: true } });

    expect(await manager.get(retired.id)).toBeDefined();
    expect(await manager.search({ query: "deployment region" })).toEqual([]);
    expect(manager.selectRelevantForPrompt(10, "deployment region").ids).toEqual([]);
    expect((await readFile(join(dir, "MEMORY.md"), "utf-8"))).not.toContain(retired.id);

    const renewed = await manager.add("The old deployment region is west");
    expect(renewed.id).not.toBe(retired.id);
    expect(manager.selectRelevantForPrompt(10, "deployment region").ids).toEqual([renewed.id]);
  });

  it("uses an explicit supersedes link to suppress an older conflicting memory", async () => {
    dir = await mkdtemp(join(tmpdir(), "vk-memory-supersedes-"));
    const manager = new MemoryManager(1000, dir);
    const old = await manager.add("The deployment region is west");
    const current = await manager.add("The deployment region is east", [], { supersedes: old.id });

    expect((await manager.search({ query: "deployment region" })).map((result) => result.entry.id)).toEqual([current.id]);
    expect(manager.selectRelevantForPrompt(10, "deployment region").ids).toEqual([current.id]);
    const reloaded = new MemoryManager(1000, dir);
    await reloaded.getAll();
    expect(reloaded.selectRelevantForPrompt(10, "deployment region").ids).toEqual([current.id]);
    expect((await readFile(join(dir, "MEMORY.md"), "utf-8"))).not.toContain(old.id);
  });

  it("keeps descriptions valid after adding or updating with an empty value", async () => {
    dir = await mkdtemp(join(tmpdir(), "vk-memory-description-"));
    const manager = new MemoryManager(1000, dir);
    const entry = await manager.add("Use SQLite for session state", [], undefined, { description: "" });
    expect((await new MemoryManager(1000, dir).get(entry.id))?.description).toBe("Use SQLite for session state");

    await manager.update(entry.id, { description: "" });
    expect((await new MemoryManager(1000, dir).get(entry.id))?.description).toBe("Use SQLite for session state");
  });

  it("loads an older auto-extracted file with an empty description", async () => {
    dir = await mkdtemp(join(tmpdir(), "vk-memory-old-description-"));
    await writeFile(join(dir, "mem-old.md"), renderMemoryFile({
      schema_version: 1,
      id: "mem-old",
      name: "Old decision",
      description: "",
      type: "project",
      scope: "project",
      importance: 0,
      signature: "old-signature",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      use_count: 0,
    }, "Use SQLite for session state"), "utf-8");

    expect((await new MemoryManager(1000, dir).get("mem-old"))?.description).toBe("Use SQLite for session state");
  });

  it("deduplicates identical content by signature", async () => {
    dir = await mkdtemp(join(tmpdir(), "ohmem-"));
    const mgr = new MemoryManager(1000, dir);
    const first = await mgr.add("the API key lives in env");
    const second = await mgr.add("The  API key lives in env!");
    expect(second.id).toBe(first.id);
    expect(mgr.count()).toBe(1);
    const mdFiles = (await readdir(dir)).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
    expect(mdFiles).toHaveLength(1);
  });

  it("maintains a MEMORY.md index with one pointer per entry", async () => {
    dir = await mkdtemp(join(tmpdir(), "ohmem-"));
    const mgr = new MemoryManager(1000, dir);
    const a = await mgr.add("first memory note");
    const b = await mgr.add("second memory note");
    const index = await readFile(join(dir, "MEMORY.md"), "utf-8");
    expect(index).toContain(a.id);
    expect(index).toContain(b.id);
    expect(index.split("\n").filter((l) => l.startsWith("- [")).length).toBe(2);
  });

  it("markMemoryUsed persists use_count to disk", async () => {
    dir = await mkdtemp(join(tmpdir(), "ohmem-"));
    const mgr = new MemoryManager(1000, dir);
    const e = await mgr.add("track usage memory");
    await mgr.markMemoryUsed(e.id);
    const raw = await readFile(join(dir, `${e.id}.md`), "utf-8");
    expect(raw).toContain("use_count: 1");
  });

  it("loads the current Markdown store directly", async () => {
    dir = await mkdtemp(join(tmpdir(), "ohmem-"));
    // Pre-seed a .md file directly.
    const md = renderMemoryFile(
      {
        schema_version: 1,
        id: "mem-seed",
        name: "seed",
        description: "seeded memory",
        type: "project",
        scope: "project",
        importance: 0,
        signature: "seed-signature",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        use_count: 0,
      },
      "seeded body content",
    );
    await writeFile(join(dir, "mem-seed.md"), md, "utf-8");
    const mgr = new MemoryManager(1000, dir);
    expect((await mgr.get("mem-seed"))!.content).toBe("seeded body content");
  });
});
