import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyResearch, renderResearchReport } from "../tools/citations.mjs";

const a = { id: "a", url: "https://example.org/a/#section", title: "Project A", text: "Project A supports text files, but does not support PDF files.", doi: "10.1234/example", date: "2026-10-01", limitation: "Pilot only" };
const b = { id: "b", url: "https://example.org/b", title: "Project B", text: "Project B supports importing PDF files for review." };
const claim = { id: "C1", text: "A supports text, excluding PDF", citations: [{ source: "a", quote: a.text }] };

test("verifies real quotes and DOI attribution while preserving metadata and semantic boundary", () => {
  const result = verifyResearch({ sources: [a], claims: [{ ...claim, citations: [{ ...claim.citations[0], doi: "10.1234/example" }] }] });
  assert.equal(result.summary.verified, 1);
  assert.equal(result.semanticVerification, "not_performed");
  assert.equal(result.references[0].date, "2026-10-01");
  assert.match(result.evidence_markdown, /Pilot only/);
});
test("resolves canonical URL references and normalizes typography, never paraphrases or negation", () => {
  const result = verifyResearch({ sources: [a], claims: [{ id: "c", text: "c", citations: [
    { url: "https://example.org/a", quote: a.text.toUpperCase() },
    { source: "a", quote: "Project A supports PDF files." },
  ] }] });
  assert.equal(result.summary.verified, 1);
  assert.equal(result.summary.flagged, 1);
  assert.equal(result.flags[0].issue, "quote_not_found_in_source");
});
test("flags wrong or malformed DOI and treats tiny quotes as weak", () => {
  const result = verifyResearch({ sources: [a], claims: [{ id: "c", text: "c", citations: [
    { source: "a", quote: a.text, doi: "invented" }, { source: "a", quote: a.text, doi: "10.1234/other" }, { source: "a", quote: "Project A" },
  ] }] });
  assert.equal(result.summary.flagged, 2);
  assert.equal(result.summary.weak, 1);
  assert.equal(result.evidence_rows.length, 0);
});
test("does not verify a DOI merely because unrelated DOI text appears in the source", () => {
  const source = { ...a, text: `${a.text} Another paper has DOI 10.1234/unrelated.` };
  const result = verifyResearch({ sources: [source], claims: [{ ...claim, citations: [
    { source: "a", quote: source.text, doi: "10.1234/unrelated" },
  ] }] });
  assert.equal(result.claims[0].citations[0].doi_status, "unverified");
  assert.equal(result.attributionPassed, false);
});
test("abstains without sources and exposes facts missing citation evidence", () => {
  assert.equal(verifyResearch({ sources: [], claims: [claim] }).abstain, true);
  const result = verifyResearch({ sources: [a], claims: [{ id: "missing", text: "Unfounded", citations: [] }] });
  assert.equal(result.attributionPassed, false);
  assert.equal(result.warnings[0].issue, "claim_evidence_missing");
});
test("binds each comparison field to its own candidate's verified claim, not another project's evidence", () => {
  const result = verifyResearch({ sources: [a,b], claims: [claim], comparison: [{
    candidate: "Project B", evidence_sources: ["b"], model_capabilities: "supports text", key_limitations: "Not verified", field_claims: { model_capabilities: ["C1"] },
  }] });
  assert.match(result.comparison_rows[0].model_capabilities, /^Not verified/);
  assert.ok(result.comparison_warnings.some(w => w.issue === "comparison_field_evidence_missing"));
});
test("keeps evidence IDs and references stable and emits complete report tables", () => {
  const result = verifyResearch({ sources: [a], claims: [claim], comparison: [{
    candidate: "Project A", evidence_sources: ["a"], model_capabilities: "Text files", key_limitations: "Not verified", field_claims: { model_capabilities: ["C1"] },
  }] });
  assert.match(result.comparison_rows[0].model_capabilities, /\[E1\]/);
  assert.match(renderResearchReport(result, { title: "Comparison", analysis: "Context and limits" }), /Context and limits/);
  assert.match(result.evidence_markdown, /does not support PDF/);
});
test("rejects ambiguous source and claim IDs", () => {
  assert.throws(() => verifyResearch({ sources: [a,a], claims: [] }), /Duplicate source/);
  assert.throws(() => verifyResearch({ sources: [a], claims: [claim,claim] }), /Duplicate claim/);
});
test("rejects a citation ID bound to a different displayed URL", () => {
  const result = verifyResearch({ sources: [a], claims: [{ ...claim, citations: [{ source: "a", url: "https://unread.example/forged", quote: a.text }] }] });
  assert.equal(result.attributionPassed, false);
  assert.equal(result.claims[0].citations[0].url_status, "unknown");
  assert.equal(result.flags[0].issue, "citation_source_url_mismatch");
});
