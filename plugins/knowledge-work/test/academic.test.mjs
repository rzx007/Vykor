import assert from "node:assert/strict";
import { test } from "node:test";
import { academicTools, searchAcademic } from "../tools/academic.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readResearchSources } from "../tools/source-records.mjs";

const hosts = ["export.arxiv.org", "api.openalex.org", "api.crossref.org", "api.semanticscholar.org", "eutils.ncbi.nlm.nih.gov"];
test("native retrieval saves sources and every actual request, including multi-stage and failed APIs", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "academic-plugin-data-")), originalFetch = globalThis.fetch;
  const ctx = { ...context(), plugin: { ...context().plugin, dataDir }, sessionId: "s", runId: "run", permissions: { network: hosts, filesystem: ["read", "write"] } };
  try {
    globalThis.fetch = (url, options) => new URL(url).hostname === "api.crossref.org"
      ? Promise.resolve(new Response("Unavailable", { status: 503 })) : fixtures(url, options);
    const output = await academicTools[0].invoke({ query: "evidence test", sources: ["openalex", "pubmed", "crossref"] }, ctx);
    const data = JSON.parse(output.content[0].text).data;
    assert.equal(data.count, 2);
    assert.deepEqual(data.storage_issues, []);
    const saved = await readResearchSources({ source_refs: data.results.map(row => row.source_ref) }, ctx);
    assert.equal(saved.sources.length, 2);
    assert.equal(saved.fetch_ledger.length, 4);
    assert.equal(saved.fetch_ledger.filter(row => row.status === "failed").length, 1);
    assert.equal(saved.sources[0].doi, "10.1000/openalex");
  } finally { globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); }
});
function context(overrides = {}) {
  return { plugin: { id: "vykor.knowledge-work", name: "knowledge-work", version: "2.0.0", root: "/plugin" },
    permissions: { network: hosts }, cwd: "/work", deadline: Date.now() + 4000,
    signal: new AbortController().signal, ...overrides };
}
const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
<entry><id>http://arxiv.org/abs/2410.00001v1</id><published>2024-10-01T12:00:00Z</published>
<title>Attention &amp; evidence</title><summary><![CDATA[An abstract with < and >.]]></summary>
<author><name>Alice Example</name></author><arxiv:doi>https://doi.org/10.1000/ARXIV</arxiv:doi></entry></feed>`;
const openalex = { meta: { count: 1 }, results: [{ id: "https://openalex.org/W1", title: "Ordered abstract", publication_date: "2024-10-02",
  doi: "https://doi.org/10.1000/OPENALEX", authorships: [{ author: { id: "A1", display_name: "Bob Example" } }],
  abstract_inverted_index: { later: [1], First: [0], words: [2] }, primary_location: { landing_page_url: "https://example.org/paper" } }] };
const crossref = { status: "ok", message: { items: [{ DOI: "10.1000/CROSSREF", title: ["Crossref paper"],
  abstract: "<jats:p>A &amp; B <jats:italic>study</jats:italic>.</jats:p>", author: [{ given: "Carol", family: "Example" }],
  issued: { "date-parts": [[2024, 10, 3]] }, URL: "https://doi.org/10.1000/CROSSREF" }] } };
const semantic = { total: 1, offset: 0, data: [{ paperId: "semantic-1", title: "Semantic paper", abstract: "Semantic abstract.",
  year: 2024, authors: [{ authorId: "a", name: "Dan Example" }], externalIds: { DOI: "10.1000/SEMANTIC" }, url: "https://www.semanticscholar.org/paper/semantic-1" }] };
const pubmed = `<?xml version="1.0"?><!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD PubMedArticle//EN" "https://dtd.nlm.nih.gov/pubmed.dtd">
<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>12345</PMID><Article><ArticleTitle>PubMed <i>clinical</i> paper</ArticleTitle>
<Abstract><AbstractText Label="BACKGROUND">A first part.</AbstractText><AbstractText Label="RESULTS">A <b>second</b> part.</AbstractText></Abstract>
<AuthorList><Author><ForeName>Eve</ForeName><LastName>Example</LastName></Author><Author><CollectiveName>Study Group</CollectiveName></Author></AuthorList>
<Journal><JournalIssue><PubDate><Year>2024</Year><Month>Oct</Month><Day>4</Day></PubDate></JournalIssue></Journal>
</Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">10.1000/PUBMED</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>`;
function json(value, init = {}) { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init }); }
function fixtures(input, init) {
  const url = new URL(input);
  assert.equal(init.redirect, "manual");
  assert.equal(url.protocol, "https:");
  assert.ok(init.signal instanceof AbortSignal);
  if (url.hostname === "export.arxiv.org") { assert.equal(url.searchParams.get("search_query"), "all:evidence test"); return Promise.resolve(new Response(atom)); }
  if (url.hostname === "api.openalex.org") return Promise.resolve(json(openalex));
  if (url.hostname === "api.crossref.org") return Promise.resolve(json(crossref));
  if (url.hostname === "api.semanticscholar.org") return Promise.resolve(json(semantic));
  if (url.pathname.endsWith("esearch.fcgi")) return Promise.resolve(json({ esearchresult: { count: "1", idlist: ["12345"] } }));
  if (url.pathname.endsWith("efetch.fcgi")) { assert.equal(url.searchParams.get("id"), "12345"); return Promise.resolve(new Response(pubmed)); }
  throw new Error(`Unexpected request: ${url}`);
}

// These fixtures catch missing source-specific fields, XML entities/inline text, and abstract reconstruction.
test("normalizes the five real provider formats to source records", async () => {
  const result = await searchAcademic({ query: "evidence test" }, context(), fixtures);
  assert.deepEqual(result.sources_queried, ["arxiv", "openalex", "crossref", "semanticscholar", "pubmed"]);
  assert.equal(result.count, 5);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.results.map(({ title, text, authors, date, doi, source }) => ({ title, text, authors, date, doi, source })), [
    { title: "Attention & evidence", text: "An abstract with < and >.", authors: ["Alice Example"], date: "2024-10-01", doi: "10.1000/arxiv", source: "arxiv" },
    { title: "Ordered abstract", text: "First later words", authors: ["Bob Example"], date: "2024-10-02", doi: "10.1000/openalex", source: "openalex" },
    { title: "Crossref paper", text: "A & B study .", authors: ["Carol Example"], date: "2024-10-03", doi: "10.1000/crossref", source: "crossref" },
    { title: "Semantic paper", text: "Semantic abstract.", authors: ["Dan Example"], date: "2024", doi: "10.1000/semantic", source: "semanticscholar" },
    { title: "PubMed clinical paper", text: "BACKGROUND: A first part. RESULTS: A second part.", authors: ["Eve Example", "Study Group"], date: "2024-10-04", doi: "10.1000/pubmed", source: "pubmed" },
  ]);
  assert.equal(result.results[4].pmid, "12345");
  assert.equal(result.results[4].url, "https://pubmed.ncbi.nlm.nih.gov/12345/");
});

test("preserves the original all-source default for an empty source array", async () => {
  const result = await searchAcademic({ query: "evidence test", sources: [] }, context(), fixtures);
  assert.equal(result.count, 5);
});

test("does not merge different long titles that merely share a leading excerpt", async () => {
  const prefix = "Long title ".repeat(110);
  const result = await searchAcademic({ query: "test", sources: "semanticscholar" }, context(), async () =>
    json({ data: [{ title: `${prefix}first` }, { title: `${prefix}second` }] }));
  assert.equal(result.count, 2);
  assert.equal(new Set(result.results.map(item => item.id)).size, 2);
  for (const item of result.results) assert.match(item.id, /^title_[0-9a-f]{64}$/);
  const repeated = await searchAcademic({ query: "test", sources: "semanticscholar" }, context(), async () =>
    json({ data: [{ title: `${prefix}first` }] }));
  assert.equal(repeated.results[0].id, result.results[0].id);
});

test("records malformed PubMed search payloads as failures rather than an empty successful search", async () => {
  const result = await searchAcademic({ query: "test", sources: "pubmed" }, context(), async () => json({ error: "Invalid search" }));
  assert.equal(result.count, 0);
  assert.match(result.errors[0]?.error ?? "", /PubMed|search/i);
});

test("accepts the current standard fetch implementation when the native tool is invoked", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = fixtures;
  try {
    const tool = academicTools.find(item => item.name === "KnowledgeAcademicSearch");
    const output = await tool.invoke({ query: "evidence test", sources: "arxiv" }, context());
    assert.equal(JSON.parse(output.content[0].text).data.count, 1);
  } finally { globalThis.fetch = original; }
});

test("isolates failed and unknown sources while preserving requested order", async () => {
  const result = await searchAcademic({ query: "evidence test", sources: "crossref,unknown,arxiv,crossref" }, context(), async (url, init) => {
    if (new URL(url).hostname === "api.crossref.org") throw new Error("Connection failed");
    return fixtures(url, init);
  });
  assert.deepEqual(result.sources_queried, ["crossref", "arxiv"]);
  assert.equal(result.results[0].source, "arxiv");
  assert.deepEqual(result.errors.map(item => item.source), ["unknown", "crossref"]);
});

test("deduplicates DOI and title deterministically despite concurrent completion", async () => {
  let release;
  const started = [];
  const waiting = new Promise(resolve => { release = resolve; });
  const result = await searchAcademic({ query: "test", sources: ["crossref", "openalex", "semanticscholar"] }, context(), async url => {
    const host = new URL(url).hostname;
    started.push(host);
    if (started.length === 3) release();
    await waiting;
    if (host === "api.crossref.org") return json({ message: { items: [{ DOI: "10.1/SHARED", title: ["First"] }, { title: ["  Same   TITLE "] }] } });
    if (host === "api.openalex.org") return json({ results: [{ doi: "https://doi.org/10.1/shared", title: "Later" }] });
    return json({ data: [{ title: "same title" }] });
  });
  assert.deepEqual(result.results.map(item => item.title), ["First", "Same TITLE"]);
  assert.equal(result.count, 2);
});

test("enforces per-source result/author bounds and the original numeric clamps", async () => {
  const result = await searchAcademic({ query: "test", sources: ["semanticscholar"], limit: 0, timeout: 99 }, context(), async url => {
    assert.equal(new URL(url).searchParams.get("limit"), "1");
    return json({ data: Array.from({ length: 40 }, (_, i) => ({ title: `Paper ${i}`, authors: Array.from({ length: 20 }, (_, j) => ({ name: `Author ${j}` })) })) });
  });
  assert.equal(result.count, 1);
  assert.equal(result.results[0].authors.length, 10);
  await assert.rejects(searchAcademic({ query: "test", timeout: Infinity }, context(), fixtures), /finite/i);
  await assert.rejects(searchAcademic({ query: " " }, context(), fixtures), /query/i);
});

test("requires exact approved network hosts rather than accepting wildcard or lookalikes", async () => {
  for (const network of [[], ["*"], ["https://export.arxiv.org.evil.example"], ["https://export.arxiv.org/private"]]) {
    const result = await searchAcademic({ query: "test", sources: "arxiv" }, context({ permissions: { network } }), async () => { throw new Error("Permission guard was bypassed"); });
    assert.equal(result.count, 0);
    assert.match(result.errors[0].error, /permission/i);
  }
  const permitted = await searchAcademic({ query: "evidence test", sources: "arxiv" }, context({ permissions: { network: ["https://export.arxiv.org/"] } }), fixtures);
  assert.equal(permitted.count, 1);
});

test("revalidates redirects and never follows disallowed, credentialed, HTTP, or nonstandard-port targets", async () => {
  for (const location of ["https://evil.example/paper", "http://export.arxiv.org/paper", "https://user:secret@export.arxiv.org/paper", "https://export.arxiv.org:8443/paper"]) {
    const calls = [];
    const result = await searchAcademic({ query: "test", sources: "arxiv" }, context(), async url => {
      calls.push(String(url));
      return new Response(null, { status: 302, headers: { location } });
    });
    assert.equal(result.count, 0);
    assert.equal(calls.length, 1);
    assert.match(result.errors[0].error, /allowed|credentials|HTTPS|port/i);
  }
});

test("checks new-host permission on redirects and allows at most three redirects", async () => {
  const denied = await searchAcademic({ query: "test", sources: "arxiv" }, context({ permissions: { network: ["export.arxiv.org"] } }), async () =>
    new Response(null, { status: 302, headers: { location: "https://api.crossref.org/works" } }));
  assert.match(denied.errors[0].error, /permission/i);
  let calls = 0;
  const endless = await searchAcademic({ query: "test", sources: "arxiv" }, context(), async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: `/loop-${calls}` } });
  });
  assert.equal(calls, 4);
  assert.match(endless.errors[0].error, /redirect/i);
});

test("follows a permitted relative redirect without changing provider parsing", async () => {
  let calls = 0;
  const result = await searchAcademic({ query: "test", sources: "arxiv" }, context(), async url => {
    calls++;
    if (calls === 1) return new Response(null, { status: 307, headers: { location: "/api/redirected" } });
    assert.equal(new URL(url).pathname, "/api/redirected");
    return new Response(atom);
  });
  assert.equal(result.count, 1);
  assert.equal(calls, 2);
});

test("rejects oversized declared and streamed bodies before parsing", async () => {
  const declared = await searchAcademic({ query: "test", sources: "arxiv" }, context(), async () => new Response("small", { headers: { "content-length": "5000001" } }));
  assert.match(declared.errors[0].error, /byte|large|size/i);
  const streamed = await searchAcademic({ query: "test", sources: "arxiv" }, context(), async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(5000001)); controller.close(); },
  })));
  assert.match(streamed.errors[0].error, /byte|large|size/i);
});

test("honors cancellation before and during network work, even when transport does not cooperate", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchAcademic({ query: "test" }, context({ signal: controller.signal }), fixtures), { name: "AbortError" });
  const active = new AbortController();
  const work = searchAcademic({ query: "test", sources: "arxiv" }, context({ signal: active.signal }), async () => new Promise(() => {}));
  active.abort();
  await assert.rejects(work, { name: "AbortError" });
});

test("enforces the host deadline while a response body stalls", async () => {
  const ctx = context({ deadline: Date.now() + 30 });
  const result = searchAcademic({ query: "test", sources: "arxiv" }, ctx, async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } })));
  await assert.rejects(result, /deadline|timeout|expired/i);
});

test("checks an elapsed deadline even when synchronous work prevents the abort timer from running", async () => {
  const ctx = context({ deadline: Date.now() + 10 });
  await assert.rejects(searchAcademic({ query: "test", sources: "semanticscholar" }, ctx, async () => {
    const until = Date.now() + 25;
    while (Date.now() < until) { /* Simulate synchronous response/parse work. */ }
    return json({ data: [{ title: "Late paper" }] });
  }), /deadline|timeout|expired/i);
});

test("rejects malformed XML and internal entity declarations without external resolution", async () => {
  for (const body of ["<feed><entry></feed>", '<!DOCTYPE feed [<!ENTITY secret SYSTEM "file:///private.txt">]><feed>&secret;</feed>']) {
    const result = await searchAcademic({ query: "test", sources: "arxiv" }, context(), async () => new Response(body));
    assert.equal(result.count, 0);
    assert.match(result.errors[0].error, /XML|entity|DTD/i);
  }
});

test("returns complete native results above 64 KiB without shortening abstracts or omitting normal results", async () => {
  const abstract = "资料".repeat(10000);
  const original = globalThis.fetch;
  globalThis.fetch = async () => json({ data: Array.from({ length: 25 }, (_, i) => ({ paperId: String(i), title: `Paper ${i}`, abstract })) });
  try {
    const output = await academicTools[0].invoke({ query: "test", sources: "semanticscholar", limit: 25 }, context());
    const result = JSON.parse(output.content[0].text).data;
    assert.ok(Buffer.byteLength(output.content[0].text) > 64 * 1024);
    assert.equal(result.count, 25);
    assert.equal(result.results.length, 25);
    assert.equal(result.results[0].text, abstract);
    assert.equal(result.results[24].text, abstract);
    assert.equal(result.truncated, undefined);
    assert.equal(result.results[0].text_truncated, undefined);
  } finally { globalThis.fetch = original; }
});

test("exports a native tool whose result explicitly reports per-provider failures", async () => {
  const registration = (await import("../tools/academic.mjs")).registerTools;
  assert.equal(typeof registration, "function");
  const tool = registration().find(item => item.name === "KnowledgeAcademicSearch");
  assert.ok(tool);
  const result = await tool.invoke({ query: "test", sources: "arxiv" }, context({ permissions: { network: [] } }));
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.count, 0);
  assert.match(envelope.data.errors[0].error, /permission/i);
});
