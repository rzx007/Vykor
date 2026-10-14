import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerTools } from "../tools/index.mjs";
import { readResearchSources, saveResearchSource, researchSourcesTool } from "../tools/source-records.mjs";

const checker = registerTools().find(tool => tool.name === "KnowledgeResearchCheck");
const parse = result => JSON.parse(result.content[0].text);
const context = { signal: new AbortController().signal, permissions: { filesystem: ["read", "write"] } };
const source = { id: "s", url: "https://example.org/docs", text: "Data persists across plugin updates. It is not synced to other devices." };
const claim = { id: "c", text: "Updates preserve data.", citations: [{ source: "s", quote: source.text }] };

test("empty or failed evidence cannot produce a report containing the supplied conclusions", async () => {
  for (const input of [
    { sources: [], claims: [] },
    { sources: [source], claims: [] },
    { sources: [source], claims: [{ ...claim, citations: [{ source: "s", quote: "Data automatically syncs to other devices." }] }] },
    { sources: [source], claims: [{ ...claim, citations: [{ source: "s", quote: "Data" }] }] },
  ]) {
    const output = await checker.invoke({ ...input, op: "report", analysis_markdown: "UNSUPPORTED CONCLUSION" }, context);
    const result = parse(output);
    assert.equal(output.isError, true);
    assert.equal(output.executionState, "completed");
    assert.equal(result.report_ready, false);
    assert.doesNotMatch(result.report_markdown, /UNSUPPORTED CONCLUSION/);
    assert.match(result.report_markdown, /尚未完成引用检查/);
  }
  const success = await checker.invoke({ op: "report", sources: [source], claims: [claim], analysis_markdown: "## Scope\n\nUpdates only." }, context);
  assert.notEqual(success.isError, true);
  assert.equal(parse(success).report_ready, true);
  assert.match(parse(success).report_markdown, /## Scope\n\nUpdates only\./);
});

test("citation checks use the saved full body and diagnose mismatches without inventing truncation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "knowledge-quality-"));
  const ctx = { ...context, plugin: { dataDir }, sessionId: "s", runId: "r" };
  try {
    const quote = "Actual final paragraph: only updates preserve data.";
    const text = "x".repeat(60000) + quote;
    const ref = await saveResearchSource(ctx, { url: source.url, text });
    const first = await readResearchSources({ source_refs: [ref], max_chars: 3000 }, ctx);
    assert.equal(first.sources[0].stored_chars, text.length);
    assert.equal(first.sources[0].source_text_truncated, false);
    assert.equal(first.sources[0].read_truncated, true);
    assert.equal(first.sources[0].next_offset, 3000);
    const last = await readResearchSources({ source_refs: [ref], offset: 60000, max_chars: 1000 }, ctx);
    assert.equal(last.sources[0].text, quote);
    assert.equal(last.sources[0].returned_offset, 60000);
    assert.equal(last.sources[0].next_offset, null);
    const input = { op: "verify", recorded_only: true, sources: [{ ...source, text: "Caller summary only.", source_ref: ref }],
      claims: [{ ...claim, citations: [{ source: "s", quote }] }] };
    const verified = parse(await checker.invoke(input, ctx));
    assert.equal(verified.attributionPassed, true);
    assert.equal(verified.source_diagnostics[0].checked_chars, text.length);
    assert.equal(verified.source_diagnostics[0].read_truncated, false);
    const failed = parse(await checker.invoke({ ...input, claims: [{ ...claim, citations: [{ source: "s", quote: "An invented exact quotation." }] }] }, ctx));
    assert.equal(failed.claims[0].citations[0].quote_status, "not_found");
    assert.equal(failed.claims[0].citations[0].source_text_truncated, false);
    assert.deepEqual(failed.source_record_issues, []);
    await assert.rejects(readResearchSources({ source_refs: [ref], offset: -1 }, ctx), /offset/);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("web import keeps explicit fetch truncation distinct from a limited source read", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "knowledge-truncated-"));
  const ctx = { ...context, plugin: { dataDir }, sessionId: "s", runId: "r",
    toolResult: { toolName: "WebFetch", toolUseId: "fetch", content: [{ type: "text", text: "URL: https://example.org/docs\nStatus: 200\nContent-Type: text/plain\n\nActual body\n...[truncated]" }] } };
  try {
    const ref = parse(await researchSourcesTool.invoke({ op: "import", tool_result_id: "fetch" }, ctx)).source_ref;
    const saved = await readResearchSources({ source_refs: [ref], max_chars: 50000 }, ctx);
    assert.equal(saved.sources[0].source_text_truncated, true);
    assert.equal(saved.sources[0].read_truncated, false);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
