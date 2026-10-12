import assert from "node:assert/strict";
import test from "node:test";
import { auditContent, evaluateResearchLedger, writingTools } from "../tools/writing.mjs";

const source = (url, families, published = "") => ({ url, families, published, status: "usable" });
const codes = (report) => report.findings.map((finding) => finding.code);

test("research gate deduplicates URLs and Unicode family labels without requiring dates", () => {
  const result = evaluateResearchLedger({
    required_families: [" ＡＩ  工具 ", "ai 工具", "Risks"],
    sources: [source("HTTPS://EXAMPLE.ORG/report/#section", ["AI 工具"]), source("https://example.org/report", ["risks"])],
  });
  assert.equal(result.decision, "READY_TO_DRAFT");
  assert.equal(result.usable_source_count, 1);
  assert.deepEqual(result.required_families, ["ai 工具", "risks"]);
  assert.deepEqual(result.undated_families, ["ai 工具", "risks"]);
  assert.equal(result.advisories.length, 1);
  assert.match(result.limits, /Collection coverage only/);
});

test("research gate keeps the distinct-source floor and missing-family decision", () => {
  const result = evaluateResearchLedger({ required_families: ["feature", "cost"], min_sources: 2, sources: [source("https://example.org/feature", ["feature"], "2026-10-12")] });
  assert.equal(result.decision, "CONTINUE_RESEARCH");
  assert.equal(result.gate_eligible, false);
  assert.deepEqual(result.missing_families, ["cost"]);
  assert.deepEqual(result.undated_families, []);
});

test("research gate ignores discovery, encyclopedia, generic and malformed rows", () => {
  const result = evaluateResearchLedger({ required_families: ["feature"], sources: [
    { status: "blocked", url: "https://example.org/blocked", families: ["feature"] },
    source("https://en.wikipedia.org/wiki/Feature", ["feature"]),
    source("https://example.org/", ["feature"]),
    source("https://example.org/tags/feature", ["feature"]),
    { status: "usable", url: "https://example.org/specific", families: [] },
    source("https://example.org/feature", ["feature"], "2026-02-30"),
  ] });
  assert.equal(result.ready, true);
  assert.equal(result.ignored_nonusable_rows, 1);
  assert.equal(result.ignored_disallowed_source_rows, 3);
  assert.equal(result.ignored_malformed_source_rows, 1);
  assert.deepEqual(result.undated_families, ["feature"]);
});

test("research gate dates are advisory, validate calendar dates and merge per-family coverage", () => {
  const result = evaluateResearchLedger({ required_families: ["feature", "cost"], sources: [
    source("https://example.org/feature", ["feature"], "2024-02-29"),
    source("https://example.org/cost", ["cost"], "2023-02-29"),
  ] });
  assert.equal(result.ready, true);
  assert.deepEqual(result.undated_families, ["cost"]);
});

test("research gate bounds inputs and rejects empty/control family labels", () => {
  for (const input of [null, {}, { required_families: [] }, { required_families: ["  "] }, { required_families: ["a\u200bb"] }, { required_families: ["a"], min_sources: 21 }, { required_families: ["a"], sources: Array(101).fill({}) }]) {
    assert.throws(() => evaluateResearchLedger(input));
  }
  const long = "主题".repeat(50);
  const result = evaluateResearchLedger({ required_families: [long], sources: [source("https://example.org/report", [long])] });
  assert.equal(Array.from(result.required_families[0]).length, 64);
  assert.equal(result.ready, true);
});

test("audit counts Markdown structure and links while masking inline/fenced code", () => {
  const report = auditContent({ text: "# Clear Useful Product Heading\n\n正文 [参考](https://example.org/report)。\n\n`TODO 50%`\n```text\nTBD 2026\n```\n" });
  assert.equal(report.summary.headings, 1);
  assert.equal(report.summary.links, 1);
  assert.equal(report.links[0].url, "https://example.org/report");
  assert.equal(codes(report).includes("unresolved_placeholder"), false);
  assert.equal(codes(report).includes("numeric_or_date_claim"), false);
  assert.ok(codes(report).includes("title_case_heading"));
});

test("audit finds placeholders, numeric and direct-quote candidates with citation presence", () => {
  const report = auditContent({ text: "TODO [待核]\n覆盖 40% 用户。\n截至 2026 年，覆盖 40% 用户。[S1]\n“这是需要核实出处和语境的原文引用”。" });
  assert.equal(report.findings.filter((finding) => finding.code === "unresolved_placeholder").length, 2);
  const numbers = report.findings.filter((finding) => finding.code === "numeric_or_date_claim");
  assert.equal(numbers[0].metadata.citation_marker_present, false);
  assert.equal(numbers[1].metadata.citation_marker_present, true);
  assert.ok(codes(report).includes("direct_quote_candidate"));
});

test("audit preserves original promotional, vague, empty and repetitive-prose checks", () => {
  const report = auditContent({ text: ["行业领先，强势赋能。", "专家认为，这标志着划时代变化。", "在当今快速发展的时代，让我们深入探讨。", "希望以上内容对你有帮助。展望未来，未来可期。", "This product offers useful options. This product has clear limits. This product needs careful setup.", "word ".repeat(46), "字".repeat(91)].join("\n") });
  for (const code of ["promotional_language", "vague_attribution", "significance_inflation", "generic_signposting", "chatbot_residue", "generic_conclusion", "repeated_sentence_opener", "long_sentence"]) assert.ok(codes(report).includes(code), code);
});

test("source comparison detects removed/added numbers, citations and funding identity", () => {
  const report = auditContent({ source_text: "2026 年覆盖 40% 用户。[S1]\n本研究由甲公司资助。", text: "2025 年覆盖 60% 用户。[S2]\n本研究由乙公司资助。" });
  assert.deepEqual(report.source_comparison.missing_numbers_or_dates, ["2026", "40%"]);
  assert.deepEqual(report.source_comparison.added_numbers_or_dates, ["2025", "60%"]);
  for (const code of ["source_number_missing", "candidate_number_added", "source_citation_missing", "candidate_citation_added", "source_disclosure_party_missing", "candidate_disclosure_party_added"]) assert.ok(codes(report).includes(code), code);
  assert.deepEqual(report.source_comparison.missing_disclosure_parties, ["甲公司"]);
});

test("source comparison checks marker multiplicity and missing disclosures", () => {
  const report = auditContent({ source_text: "30% [1]。30% [1]。\nSponsored by Acme.", text: "30% [1]。" });
  assert.deepEqual(report.source_comparison.missing_numbers_or_dates, ["30%"]);
  assert.deepEqual(report.source_comparison.missing_citations, ["[1]"]);
  assert.ok(codes(report).includes("source_disclosure_missing"));
  assert.equal(report.source_comparison.candidate_disclosure_present, false);
});

test("audit flags newly introduced bridge claims without pretending semantic verification", () => {
  const report = auditContent({ source_text: "本试点涵盖三个团队，未测量长期效果。", text: "本试点证明有效，为未来提供基础，下一步需要进一步研究。" });
  assert.ok(codes(report).includes("new_bridge_claim"));
  assert.ok(report.source_comparison.new_bridge_claims.some((claim) => claim.type === "effectiveness_inference"));
  assert.equal("ready" in report, false);
  assert.equal("decision" in report, false);
  assert.match(report.limitations.join(" "), /lexical.*not semantic/);
});

test("audit keeps higher-severity late findings when the return limit is reached", () => {
  const report = auditContent({ text: "行业领先。\n未来可期。\nTODO\nTBD", max_findings: 1 });
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].code, "unresolved_placeholder");
  assert.equal(report.findings[0].line, 3);
  assert.equal(report.summary.findings_truncated, true);
});

test("source comparison caps returned repeated values while retaining the full count", () => {
  const report = auditContent({ source_text: "30% ".repeat(1200), text: "", max_findings: 1 });
  assert.equal(report.source_comparison.missing_numbers_or_dates_total, 1200);
  assert.equal(report.source_comparison.missing_numbers_or_dates.length, 1000);
  assert.equal(report.source_comparison.values_truncated, true);
});

test("audit bounds findings, links and UTF-8 input bytes including direct calls", () => {
  for (const input of [{ text: "a", max_findings: 0 }, { text: "a", max_findings: 1001 }, { text: "a", max_findings: 1.5 }, { text: 123 }, { text: "汉".repeat(700_000) }, { text: "ok", source_text: "汉".repeat(700_000) }]) assert.throws(() => auditContent(input));
  const report = auditContent({ text: Array(5001).fill("https://example.org/report").join("\n") });
  assert.equal(report.summary.links, 5001);
  assert.equal(report.links.length, 5000);
  assert.equal(report.summary.links_truncated, true);
});

test("Native writing tools return structured results and honor cancellation", async () => {
  const context = { signal: new AbortController().signal };
  assert.deepEqual(writingTools.map((tool) => tool.name), ["KnowledgeWritingGate", "KnowledgeContentAudit"]);
  const gate = await writingTools[0].invoke({ required_families: ["scope"], sources: [] }, context);
  assert.equal(JSON.parse(gate.content[0].text).decision, "CONTINUE_RESEARCH");
  const audit = await writingTools[1].invoke({ text: "TODO" }, context);
  assert.equal(JSON.parse(audit.content[0].text).findings[0].code, "unresolved_placeholder");
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(async () => writingTools[1].invoke({ text: "draft" }, { signal: stopped.signal }), /abort/i);
});
