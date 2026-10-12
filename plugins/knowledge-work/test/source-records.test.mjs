import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveResearchSource, appendResearchAttempts, readResearchSources, researchSourcesTool } from "../tools/source-records.mjs";
test("plugin data survives cwd changes, detects damage, and counts actual requests without duplicate imports", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "plugin-source-data-"));
  const context = { plugin: { id: "vykor.knowledge-work", dataDir }, cwd: "/first-project", sessionId: "s", runId: "run",
    permissions: { filesystem: ["read", "write"] }, signal: new AbortController().signal };
  try {
    const ref = await saveResearchSource(context, { url: "https://example.org/a", text: "Actual source text supports this narrow claim.", doi: "10.1234/first" });
    await appendResearchAttempts(context, [{ kind: "fetch", tool_call_id: "web", status: "ok", recorded_at: "2026-10-12T00:00:00Z" },
      { kind: "fetch", tool_call_id: "web", status: "ok", recorded_at: "2026-10-12T00:00:00Z" },
      { kind: "fetch", request_id: "api1", status: "failed", recorded_at: "2026-10-12T00:00:00Z" }]);
    const result = await readResearchSources({ source_refs: [ref] }, { ...context, cwd: "/moved-project" });
    assert.equal(result.sources[0].plugin_recorded, true);
    assert.equal(result.sources[0].doi, "10.1234/first");
    assert.equal(result.fetch_ledger.length, 2);
    assert.equal(result.ledger_complete, true);
    const path = join(dataDir, "research", "sources", ref + ".json");
    const record = JSON.parse(await readFile(path, "utf8"));
    record.source.text = "Damaged body";
    await writeFile(path, JSON.stringify(record));
    assert.equal((await readResearchSources({ source_refs: [ref] }, context)).sources.length, 0);
    await assert.rejects(readResearchSources({ source_refs: ["../../private"] }, context), /reference/);
    await assert.rejects(readResearchSources({ source_refs: [] }, { ...context, permissions: {} }), /permission/);
    await assert.rejects(researchSourcesTool.invoke({ op: "import", tool_result_id: "fake" }, context), /actual WebFetch/);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
test("plugin persistence refuses a source directory escaping its data root", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "plugin-data-link-")), outside = await mkdtemp(join(tmpdir(), "plugin-data-outside-"));
  try {
    await mkdir(join(dataDir, "research")); await symlink(outside, join(dataDir, "research", "sources"), "junction");
    await assert.rejects(saveResearchSource({ plugin: { dataDir }, permissions: { filesystem: ["write"] } },
      { url: "https://example.org", text: "Actual text" }), /Unsafe/);
  } finally { await rm(dataDir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
