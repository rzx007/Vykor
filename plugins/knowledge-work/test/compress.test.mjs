import assert from "node:assert/strict";
import test from "node:test";
import { compressEvidence, compressionTools } from "../tools/compress.mjs";

const relevant = [
  "Local-first AI agent systems keep user data on the device.",
  "This local first design runs offline so sensitive documents stay private.",
  "Researchers describe on-device privacy as the central guarantee of a trustworthy ai agent.",
  "Keeping inference local removes the need to trust a remote operator with raw prompt history.",
].join(" ");
const realEstate = "The listing agent showed the house to prospective buyers, reviewed mortgage paperwork and arranged the final inspection with the broker. ";
const noise = "The chef simmered tomato sauce, plated pasta with fresh cheese and brewed coffee while the pastry cook folded butter into dough. ";

test("large evidence ranks topical text before superficial overlap and excludes unrelated prose", () => {
  const result = compressEvidence({ query: "local first AI agent privacy", sources: [
    { id: "a", url: "https://example.org/a", title: "Architecture", text: relevant },
    { id: "b", text: realEstate.repeat(10) },
    { id: "c", text: noise.repeat(10) },
  ] });
  assert.equal(result.stats.skipped_compression, false);
  assert.equal(result.kept[0].source, "a");
  assert.equal(result.kept[0].chunk, relevant);
  assert.equal(result.kept[0].url, "https://example.org/a");
  assert.equal(result.kept[0].title, "Architecture");
  assert.equal(result.kept.some(row => row.source === "c"), false);
  assert.ok(result.dropped_low_relevance > 0);
  assert.ok(result.kept.every(row => [...row.chunk].length <= 1200));
  assert.ok(result.stats.chars_out <= result.budget_chars);
});

test("CJK queries rank actual evidence and preserve its source identity", () => {
  const result = compressEvidence({ query: "中文压缩预算如何严格执行", max_chars: 1200, sources: [
    { id: "research", text: "本研究分析中文压缩预算，要求所有输出严格遵守字符上限并保留关键证据。".repeat(80) },
    { id: "menu", text: "餐厅今天准备了面包、咖啡和水果，厨师随后整理了厨房。".repeat(80) },
  ] });
  assert.ok(result.kept.length > 0);
  assert.equal(result.kept[0].source, "research");
  assert.ok(result.kept.every(row => row.source !== "menu"));
  assert.ok(result.stats.chars_out <= 1200);
});

test("academic records retain citation metadata through native compression", () => {
  const source = {
    id: "https://openalex.org/W123", source: "openalex", title: "Agent privacy", text: relevant,
    url: "https://doi.org/10.1234/example", doi: "10.1234/example", date: "2026-01-02",
    authors: ["Ada Lovelace"], pmid: null,
    source_ref: "ec7a1d8c-2b1d-4bd1-9586-6485dfac025b", text_truncated: true,
    accessed_at: "2026-10-12T01:23:45.000Z",
  };
  const result = compressEvidence({ query: "privacy", sources: [source] });
  assert.equal(result.kept[0].source, source.id);
  assert.equal(result.kept[0].source_type, "openalex");
  assert.equal(result.kept[0].doi, source.doi);
  assert.equal(result.kept[0].date, source.date);
  assert.deepEqual(result.kept[0].authors, source.authors);
  assert.equal(result.kept[0].source_ref, source.source_ref);
  assert.equal(result.kept[0].text_truncated, true);
  assert.equal(result.kept[0].accessed_at, source.accessed_at);
});

test("small content passes through without scoring but still deduplicates and observes its budget", () => {
  const result = compressEvidence({ query: "privacy", sources: [
    { id: "a", text: "Tiny private ai agent note." },
    { id: "b", text: "  TINY private AI agent note.  " },
  ] });
  assert.equal(result.stats.skipped_compression, true);
  assert.equal(result.stats.deduped, 1);
  assert.equal(result.kept[0].score, null);
  assert.equal(result.kept[0].source, "a");
  assert.equal(result.kept[0].chunk, "Tiny private ai agent note.");
  const tinyBudget = compressEvidence({ query: "", max_chars: 40, sources: [{ id: "a", text: relevant }] });
  assert.equal(tinyBudget.stats.skipped_compression, false);
  assert.equal(tinyBudget.stats.chars_out, 0);
});

test("near duplicate passages collapse while half-overlap passages retain separate evidence", () => {
  const base = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon";
  const near = base.replace("upsilon", "phi");
  const different = "alpha beta gamma delta epsilon lorem ipsum dolor sit amet";
  const result = compressEvidence({ query: "", sources: [
    { id: "base", text: base }, { id: "near", text: near }, { id: "different", text: different },
  ] });
  assert.equal(result.stats.deduped, 1);
  assert.deepEqual(result.kept.map(row => row.source), ["base", "different"]);
  assert.equal(result.kept[0].chunk, base);
});

test("near duplicate evidence retains differing negation, quantities and scope conditions", () => {
  const english = "PDF handling is supported by the local offline document pipeline covering research evidence extraction, authors, citations, reports, dates, storage, sources, and claims.";
  const chinese = "甲项目支持PDF文件，研究材料涵盖作者、日期、引用、报告、资料保存、证据整理、来源定位、文献分类、文件目录、文本检索、版本管理和修改记录。";
  for (const [first, second] of [
    [english, english.replace("is supported", "is not supported")],
    [english, english.replace("is supported", "is never supported")],
    [`${english} A study covered 10 teams.`, `${english} A study covered 20 teams.`],
    [`${english} Available if licensed.`, `${english} Available unless licensed.`],
    [chinese, chinese.replace("支持PDF", "不支持PDF")],
    [chinese, chinese.replace("支持PDF", "未支持PDF")],
    [chinese, chinese.replace("研究材料", "无研究材料")],
    [chinese, chinese.replace("支持PDF", "仅支持PDF")],
    [chinese, `${chinese}扫描件除外。`],
  ]) {
    const result = compressEvidence({ query: "", sources: [
      { id: "first", text: first }, { id: "second", text: second },
    ] });
    assert.deepEqual(result.kept.map(row => row.source), ["first", "second"], "contradictory or differently scoped evidence must not merge");
    assert.equal(result.stats.deduped, 0);
  }
});

test("empty queries still split and enforce budgets, including Unicode code points", () => {
  const result = compressEvidence({ query: "", max_chars: 120, sources: [
    { id: "emoji", path: "notes.md", text: "😀".repeat(100) },
    { id: "latin", text: "x".repeat(100) },
  ] });
  assert.equal(result.stats.skipped_scoring, true);
  assert.equal(result.stats.chars_out, 100);
  assert.equal(result.kept[0].chunk, "😀".repeat(100));
  assert.equal(result.kept[0].path, "notes.md");
  assert.ok(result.kept.every(row => !/[\uD800-\uDBFF]$/u.test(row.chunk)));
  const zero = compressEvidence({ query: "", max_chars: 0, sources: [{ id: "a", text: relevant }] });
  assert.deepEqual(zero.kept, []);
  assert.equal(zero.stats.chars_out, 0);
});

test("sentence/paragraph splitting never overruns chunk limits or per-source limits", () => {
  const text = `${relevant}\n\n${realEstate}\n\n${noise}`;
  const result = compressEvidence({ query: "", max_chars: 2500, max_per_source: 1, sources: [
    { id: "a", text }, { id: "b", text: "z".repeat(2400) },
  ] });
  assert.ok(result.kept.length >= 2);
  assert.equal(result.kept.filter(row => row.source === "a").length, 1);
  assert.equal(result.kept.filter(row => row.source === "b").length, 1);
  assert.ok(result.kept.every(row => [...row.chunk].length <= 1200));
  assert.ok(result.stats.chars_out <= 2500);
  assert.ok(result.kept.every(row => Number.isInteger(row.chunk_index)));
});

test("long CJK and Latin sentences without spaces remain verifiable original excerpts", () => {
  for (const unit of [
    "甲项目支持文本文件，但不支持PDF文件。该研究只涉及三个团队，未测量长期效果。",
    "Project Alpha supports text files,but does not support PDF files.The study covered three teams;long-term effects were not measured.",
  ]) {
    const text = unit.repeat(70);
    const result = compressEvidence({ query: "", sources: [{ id: "source", text }] });
    assert.equal(result.stats.skipped_compression, false);
    assert.ok(result.kept.length > 0);
    const original = text.replace(/\s+/gu, " ").trim();
    for (const row of result.kept) {
      assert.ok(original.includes(row.chunk.replace(/\s+/gu, " ").trim()), "retained evidence must occur in the original source");
    }
  }
});

test("input source and aggregate ceilings are observable instead of silently discarding material", () => {
  const text = "x".repeat(100001);
  const result = compressEvidence({ query: "", sources: Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, text })) });
  assert.equal(result.stats.sources_input, 7);
  assert.equal(result.stats.sources_considered, 5);
  assert.equal(result.stats.sources_dropped, 2);
  assert.equal(result.stats.sources_truncated, 5);
  assert.equal(result.stats.chars_in, 500000);
  assert.equal(result.stats.chars_input_raw, 700007);
  assert.equal(result.stats.chars_truncated, 200007);
  assert.equal(result.stats.input_capped, true);
  const tooMany = compressEvidence({ query: "", sources: Array.from({ length: 201 }, (_, i) => ({ id: `s${i}`, text: "a" })) });
  assert.equal(tooMany.stats.sources_considered, 200);
  assert.equal(tooMany.stats.sources_dropped, 1);
});

test("invalid numeric budgets and threshold values cannot produce unbounded or misleading output", () => {
  for (const value of [NaN, Infinity, -Infinity, "oops"]) {
    assert.throws(() => compressEvidence({ sources: [], max_chars: value }), /finite|number/i);
    assert.throws(() => compressEvidence({ sources: [], min_score: value }), /finite|number/i);
  }
  assert.equal(compressEvidence({ sources: [], max_chars: -5 }).budget_chars, 0);
  assert.throws(() => compressEvidence({ sources: [{ id: "a", text: {} }] }), /source.*text|text.*string/i);
});

test("the native compression tool checks cancellation and exposes retained chunks", () => {
  const [tool] = compressionTools;
  assert.equal(tool.name, "KnowledgeEvidenceCompress");
  const result = tool.invoke({ query: "", sources: [{ id: "a", text: "A short note." }] }, { signal: new AbortController().signal });
  assert.equal(JSON.parse(result.content[0].text).data.kept[0].chunk, "A short note.");
  const controller = new AbortController(); controller.abort();
  assert.throws(() => tool.invoke({ sources: [] }, { signal: controller.signal }), /abort/i);
});
