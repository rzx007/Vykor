/** Public academic APIs, adapted from Orkas academic.py (see THIRD-PARTY-NOTICES.md).
 * Only fixed HTTPS API hosts are fetched. Abstracts are source text, not full papers.
 * Native Tool Host does not inherit HTTP(S)_PROXY; this module uses Node's fetch as provided.
 */
import { createHash, randomUUID } from "node:crypto";
import { saveResearchSource, appendResearchAttempts } from "./source-records.mjs";
/** @typedef {import('@vykor/plugins/sdk').NativeToolInvocationContext} InvocationContext */
/** @typedef {{id:string,source:string,title:string,text:string,authors:string[],date:string|null,doi:string|null,url:string|null,pmid?:string|null}} AcademicRecord */
/** @typedef {{source:string,error:string}} SourceError */
/** @typedef {{query:string,sources_queried:string[],count:number,results:AcademicRecord[],errors:SourceError[]}} SearchResult */
/** @typedef {{name:string,attrs:Record<string,string>,parts:(XmlNode|string)[]}} XmlNode */
/** @typedef {{status:number,ok:boolean,url?:string,headers:{get(name:string):string|null},body?:Response['body']}} HttpResponse */
/** @typedef {(url:URL,options:{redirect:'manual',signal:AbortSignal,headers:Record<string,string>})=>Promise<HttpResponse>} AcademicFetch */

const HOSTS = new Set(["export.arxiv.org", "api.openalex.org", "api.crossref.org", "api.semanticscholar.org", "eutils.ncbi.nlm.nih.gov"]);
const SOURCES = ["arxiv", "openalex", "crossref", "semanticscholar", "pubmed"];
const MAX_BYTES = 5_000_000;
const USER_AGENT = "OpenHarnessKnowledgeWork/2.0 (academic research)";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** @param {unknown} value */
function clean(value) { return typeof value === "string" || typeof value === "number" ? String(value).replace(/\s+/gu, " ").trim() : ""; }
/** @param {unknown} value @returns {Record<string,unknown>} */
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string,unknown>} */ (value) : {}; }
/** @param {unknown} value @returns {unknown[]} */
function array(value) { return Array.isArray(value) ? value : []; }
/** @param {unknown} value */
function doi(value) { return clean(value).replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "").toLowerCase() || null; }
/** @param {string} source @param {unknown} title @param {unknown} text @param {unknown[]} authors @param {unknown} date @param {unknown} rawDoi @param {unknown} url @param {unknown} id @returns {AcademicRecord} */
function record(source, title, text, authors, date, rawDoi, url, id) {
  const abstract = clean(text);
  const actualTitle = clean(title);
  const fallback = `title_${createHash("sha256").update(actualTitle.toLowerCase()).digest("hex")}`;
  return { id: clean(id) || clean(url) || doi(rawDoi) || fallback, source, title: actualTitle,
    text: abstract, authors: authors.map(clean).filter(Boolean).slice(0, 10),
    date: clean(date) || null, doi: doi(rawDoi), url: clean(url) || null };
}

/** Decode only XML's predefined/numeric entities; never load a DTD or expand declared entities. @param {string} text */
function entities(text) {
  return text.replace(/&([^;\s<&]+);/gu, (_whole, key) => {
    const known = /** @type {Record<string,string>} */ ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" });
    if (known[key] !== undefined) return known[key];
    const number = /^#x[0-9a-f]+$/iu.test(key) ? Number.parseInt(key.slice(2), 16)
      : /^#\d+$/u.test(key) ? Number.parseInt(key.slice(1), 10) : NaN;
    if (!Number.isInteger(number) || number <= 0 || number > 0x10ffff || (number >= 0xd800 && number <= 0xdfff)) throw new Error("Unsupported XML entity");
    return String.fromCodePoint(number);
  });
}

/** Small, bounded XML reader for Atom/PubMed: namespaces, CDATA, inline text, no entity resolution. @param {string} xml @returns {XmlNode} */
function parseXml(xml) {
  if (/<!ENTITY\b/iu.test(xml) || /<!DOCTYPE[^>]*\[/iu.test(xml)) throw new Error("XML internal DTD/entity declarations are not supported");
  /** @type {XmlNode} */
  const document = { name: "#document", attrs: {}, parts: [] };
  const stack = [document];
  let position = 0, nodes = 0;
  while (position < xml.length) {
    const current = stack[stack.length - 1];
    if (!current) throw new Error("Invalid XML nesting");
    if (xml[position] !== "<") {
      const end = xml.indexOf("<", position);
      const next = end < 0 ? xml.length : end;
      current.parts.push(entities(xml.slice(position, next)));
      position = next;
      continue;
    }
    if (xml.startsWith("<!--", position) || xml.startsWith("<?", position) || xml.startsWith("<![CDATA[", position)) {
      const cdata = xml.startsWith("<![CDATA[", position);
      const comment = xml.startsWith("<!--", position);
      const opening = cdata ? 9 : comment ? 4 : 2;
      const closing = cdata ? "]]>" : comment ? "-->" : "?>";
      const end = xml.indexOf(closing, position + opening);
      if (end < 0) throw new Error("Unclosed XML declaration/comment/CDATA");
      if (cdata) current.parts.push(xml.slice(position + opening, end));
      position = end + closing.length;
      continue;
    }
    if (/^<!DOCTYPE\b/iu.test(xml.slice(position, position + 12))) {
      const end = xml.indexOf(">", position);
      if (end < 0) throw new Error("Unclosed XML DOCTYPE");
      position = end + 1; // PubMed includes an external DTD reference; it is deliberately never fetched.
      continue;
    }
    const token = /^<\/?[A-Za-z_:][\w:.-]*(?:[^<>"']|"[^"]*"|'[^']*')*>/u.exec(xml.slice(position));
    if (!token) throw new Error("Invalid XML tag");
    const raw = token[0];
    position += raw.length;
    const fullName = /^<\/?([\w:.-]+)/u.exec(raw)?.[1] ?? "";
    if (raw.startsWith("</")) {
      if (stack.length === 1 || current.name !== fullName || !/^<\/[\w:.-]+\s*>$/u.test(raw)) throw new Error("Mismatched XML closing tag");
      stack.pop();
      continue;
    }
    if (++nodes > 100_000 || stack.length > 100) throw new Error("XML nesting or node limit exceeded");
    /** @type {XmlNode} */
    const node = { name: fullName, attrs: {}, parts: [] };
    const attributes = raw.slice(fullName.length + 1).replace(/\/?>$/u, "");
    let consumed = 0;
    const pattern = /\s+([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
    for (const match of attributes.matchAll(pattern)) {
      if (attributes.slice(consumed, match.index).trim()) throw new Error("Invalid XML attribute");
      const key = match[1] ?? "";
      if (Object.hasOwn(node.attrs, key)) throw new Error("Duplicate XML attribute");
      node.attrs[key] = entities(match[2] ?? match[3] ?? "");
      consumed = (match.index ?? 0) + match[0].length;
    }
    if (attributes.slice(consumed).trim()) throw new Error("Invalid XML attributes");
    current.parts.push(node);
    if (!raw.endsWith("/>")) stack.push(node);
  }
  if (stack.length !== 1 || children(document).length !== 1 || document.parts.some(part => typeof part === "string" && part.trim())) throw new Error("Invalid XML document");
  return document;
}
/** @param {XmlNode} node @param {string} [name] @returns {XmlNode[]} */
function children(node, name) {
  return node.parts.filter(/** @returns {part is XmlNode} */ (part) => typeof part !== "string")
    .filter(part => !name || part.name.split(":").at(-1) === name);
}
/** @param {XmlNode} node @param {string} name @returns {XmlNode[]} */
function descendants(node, name) {
  /** @type {XmlNode[]} */
  const result = [];
  for (const child of children(node)) {
    if (child.name.split(":").at(-1) === name) result.push(child);
    result.push(...descendants(child, name));
  }
  return result;
}
/** @param {XmlNode|undefined} node @returns {string} */
function xmlText(node) { return node ? node.parts.map(part => typeof part === "string" ? part : xmlText(part)).join("") : ""; }
/** @param {XmlNode} node @param {string} name */
function childText(node, name) { return clean(xmlText(children(node, name)[0])); }

/** @param {string} xml @param {number} limit */
function parseArxiv(xml, limit) {
  const root = parseXml(xml);
  if (children(root)[0]?.name.split(":").at(-1) !== "feed") throw new Error("Invalid arxiv XML feed");
  return descendants(root, "entry").slice(0, limit).map(entry => {
    const id = childText(entry, "id");
    return record("arxiv", childText(entry, "title"), childText(entry, "summary"),
      children(entry, "author").map(author => childText(author, "name")), childText(entry, "published").slice(0, 10), childText(entry, "doi"), id, id);
  });
}
/** @param {unknown} input @param {number} limit */
function parseOpenalex(input, limit) {
  const value = object(input);
  if (!Array.isArray(value.results)) throw new Error("Invalid OpenAlex results");
  return array(value.results).slice(0, limit).filter(item => item && typeof item === "object").map(item => {
    const paper = object(item);
    /** @type {[number,string][]} */
    const positions = [];
    for (const [word, indexes] of Object.entries(object(paper.abstract_inverted_index))) {
      for (const index of array(indexes)) if (typeof index === "number" && Number.isSafeInteger(index) && index >= 0) positions.push([index, word]);
    }
    positions.sort((left, right) => left[0] - right[0] || left[1].localeCompare(right[1]));
    return record("openalex", paper.title || paper.display_name, positions.map(pair => pair[1]).join(" "),
      array(paper.authorships).map(author => object(object(author).author).display_name), paper.publication_date || paper.publication_year,
      paper.doi, paper.id || object(paper.primary_location).landing_page_url, paper.id);
  });
}
/** @param {unknown} input @param {number} limit */
function parseCrossref(input, limit) {
  const items = object(object(input).message).items;
  if (!Array.isArray(items)) throw new Error("Invalid Crossref results");
  return array(items).slice(0, limit).filter(item => item && typeof item === "object").map(item => {
    const paper = object(item);
    const parts = array(array(object(paper.issued)["date-parts"])[0]).slice(0, 3);
    const date = parts.length && parts.every(part => Number.isInteger(part))
      ? parts.map((part, index) => index ? String(part).padStart(2, "0") : String(part)).join("-") : "";
    const authors = array(paper.author).map(item => {
      const author = object(item);
      return [clean(author.given), clean(author.family)].filter(Boolean).join(" ") || clean(author.name);
    });
    const url = paper.URL || (clean(paper.DOI) ? `https://doi.org/${clean(paper.DOI)}` : "");
    return record("crossref", array(paper.title)[0], entities(clean(paper.abstract).replace(/<[^>]+>/gu, " ")), authors, date, paper.DOI, url, paper.DOI || url);
  });
}
/** @param {unknown} input @param {number} limit */
function parseSemantic(input, limit) {
  const value = object(input);
  if (!Array.isArray(value.data)) throw new Error("Invalid Semantic Scholar results");
  return array(value.data).slice(0, limit).filter(item => item && typeof item === "object").map(item => {
    const paper = object(item), rawDoi = object(paper.externalIds).DOI;
    const url = paper.url || (clean(rawDoi) ? `https://doi.org/${clean(rawDoi)}` : "");
    return record("semanticscholar", paper.title, paper.abstract, array(paper.authors).map(author => object(author).name), paper.year,
      rawDoi, url, paper.paperId || rawDoi || url);
  });
}
/** @param {XmlNode} article */
function pubmedDate(article) {
  const date = descendants(article, "ArticleDate")[0] ?? descendants(article, "PubDate")[0];
  if (!date) return "";
  const year = childText(date, "Year");
  if (!year) return childText(date, "MedlineDate");
  const month = childText(date, "Month"), day = childText(date, "Day");
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const numeric = /^\d+$/u.test(month) ? Number(month) : months.indexOf(month.slice(0, 3).toLowerCase()) + 1;
  if (numeric < 1 || numeric > 12) return year;
  return `${year}-${String(numeric).padStart(2, "0")}${/^\d+$/u.test(day) ? `-${day.padStart(2, "0")}` : ""}`;
}
/** @param {string} xml @param {number} limit */
function parsePubmed(xml, limit) {
  const root = parseXml(xml);
  if (children(root)[0]?.name.split(":").at(-1) !== "PubmedArticleSet") throw new Error("Invalid PubMed XML document");
  return descendants(root, "PubmedArticle").slice(0, limit).map(item => {
    const citation = children(item, "MedlineCitation")[0];
    const article = citation && children(citation, "Article")[0];
    if (!citation || !article) throw new Error("Invalid PubMed article");
    const pmid = childText(citation, "PMID");
    const abstract = descendants(article, "AbstractText").map(node => {
      const text = clean(xmlText(node)), label = clean(node.attrs.Label);
      return text ? (label ? `${label}: ${text}` : text) : "";
    }).filter(Boolean).join(" ");
    const authors = descendants(article, "Author").map(node => childText(node, "CollectiveName") ||
      [childText(node, "ForeName"), childText(node, "LastName")].filter(Boolean).join(" "));
    const rawDoi = descendants(item, "ArticleId").find(node => clean(node.attrs.IdType).toLowerCase() === "doi");
    const url = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "";
    return { ...record("pubmed", childText(article, "ArticleTitle"), abstract, authors, pubmedDate(article), xmlText(rawDoi), url, pmid || xmlText(rawDoi) || url), pmid: pmid || null };
  });
}

/** @param {URL} url @param {InvocationContext} context */
function assertAllowed(url, context) {
  if (url.protocol !== "https:") throw new Error("Only HTTPS academic API requests are allowed");
  if (!HOSTS.has(url.hostname)) throw new Error("Academic API host is not allowed");
  if (url.username || url.password) throw new Error("URL credentials are not allowed");
  if (url.port && url.port !== "443") throw new Error("Nonstandard HTTPS ports are not allowed");
  const network = context.permissions.network ?? [];
  if (!network.some(grant => grant === url.hostname || grant === `https://${url.hostname}` || grant === `https://${url.hostname}/`)) throw new Error(`Network permission is required for ${url.hostname}`);
}
/** Race each external await so cancellation/deadline does not depend on a cooperative transport. @template T @param {Promise<T>} promise @param {AbortSignal} signal @returns {Promise<T>} */
function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
/** @param {HttpResponse} response @param {AbortSignal} signal */
async function readBounded(response, signal) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`Academic response exceeds ${MAX_BYTES} byte limit`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0, completed = false;
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) { completed = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) throw new Error(`Academic response exceeds ${MAX_BYTES} byte limit`);
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } finally {
    if (!completed) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** @param {URL} initial @param {string} accept @param {number} timeout @param {InvocationContext} context @param {AbortSignal} callSignal @param {AcademicFetch} fetchFn */
async function get(initial, accept, timeout, context, callSignal, fetchFn) {
  const request = new AbortController();
  const timer = setTimeout(() => request.abort(new DOMException("Academic request timeout", "TimeoutError")), timeout * 1000);
  const signal = AbortSignal.any([callSignal, request.signal]);
  let url = initial;
  try {
    for (let redirects = 0; ; redirects++) {
      signal.throwIfAborted();
      if (Date.now() >= context.deadline) throw new DOMException("Academic call deadline expired", "TimeoutError");
      assertAllowed(url, context);
      const response = await abortable(fetchFn(url, { redirect: "manual", signal, headers: { "User-Agent": USER_AGENT, Accept: accept } }), signal);
      if (response.url) assertAllowed(new URL(response.url), context);
      if (REDIRECTS.has(response.status)) {
        void response.body?.cancel().catch(() => {});
        if (redirects >= 3) throw new Error("Academic redirect limit exceeded");
        const location = response.headers.get("location");
        if (!location) throw new Error("Academic redirect is missing Location");
        url = new URL(location, url);
        assertAllowed(url, context);
        continue;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`Academic API HTTP ${response.status}`);
      }
      return await readBounded(response, signal);
    }
  } finally { clearTimeout(timer); }
}
/** @param {string} base @param {Record<string,string|number>} parameters */
function endpoint(base, parameters) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
  return url;
}
/** @param {string} source @param {string} query @param {number} limit @param {number} timeout @param {InvocationContext} context @param {AbortSignal} signal @param {AcademicFetch} fetchFn @returns {Promise<AcademicRecord[]>} */
async function fetchSource(source, query, limit, timeout, context, signal, fetchFn) {
  /** @param {URL} url @param {string} [accept] */
  const read = (url, accept = "application/json") => get(url, accept, timeout, context, signal, fetchFn);
  switch (source) {
    case "arxiv": return parseArxiv(await read(endpoint("https://export.arxiv.org/api/query", { search_query: `all:${query}`, start: 0, max_results: limit }), "application/atom+xml"), limit);
    case "openalex": return parseOpenalex(JSON.parse(await read(endpoint("https://api.openalex.org/works", { search: query, per_page: limit }))), limit);
    case "crossref": return parseCrossref(JSON.parse(await read(endpoint("https://api.crossref.org/works", { query, rows: limit }))), limit);
    case "semanticscholar": return parseSemantic(JSON.parse(await read(endpoint("https://api.semanticscholar.org/graph/v1/paper/search", { query, limit, fields: "title,abstract,year,authors,externalIds,url" }))), limit);
    case "pubmed": {
      const value = JSON.parse(await read(endpoint("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi", { db: "pubmed", term: query, retmax: limit, retmode: "json" })));
      const idlist = object(object(value).esearchresult).idlist;
      if (!Array.isArray(idlist)) throw new Error("Invalid PubMed search results");
      const ids = idlist.slice(0, limit).map(clean).filter(id => /^\d+$/u.test(id));
      if (!ids.length) return [];
      return parsePubmed(await read(endpoint("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi", { db: "pubmed", id: ids.join(","), retmode: "xml" }), "application/xml"), limit);
    }
    default: throw new Error("Unknown academic source");
  }
}

/** @param {Record<string,unknown>} input @param {InvocationContext} context @param {AcademicFetch} [fetchFn] @returns {Promise<SearchResult>} */
export async function searchAcademic(input, context, fetchFn = globalThis.fetch) {
  context.signal.throwIfAborted();
  const query = clean(input.query);
  if (!query || query.length > 2000) throw new TypeError("query must contain 1–2000 characters");
  const rawLimit = input.limit ?? 5, rawTimeout = input.timeout ?? 30;
  if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit) || !Number.isInteger(rawLimit)) throw new TypeError("limit must be a finite integer");
  if (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout)) throw new TypeError("timeout must be finite seconds");
  const limit = Math.max(1, Math.min(rawLimit, 25)), timeout = Math.max(1, Math.min(rawTimeout, 60));
  const requested = input.sources === undefined || input.sources === "" || Array.isArray(input.sources) && input.sources.length === 0 ? SOURCES
    : typeof input.sources === "string" ? input.sources.split(",").map(item => item.trim()) : input.sources;
  if (!Array.isArray(requested) || requested.length > 20 || requested.some(item => typeof item !== "string" || item.length > 80)) throw new TypeError("sources must be a bounded source list or comma-separated names");
  if (!Number.isFinite(context.deadline) || context.deadline <= Date.now()) throw new DOMException("Academic call deadline expired", "TimeoutError");
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException("Academic call deadline expired", "TimeoutError")), Math.min(context.deadline - Date.now(), 120_000));
  const signal = AbortSignal.any([context.signal, deadline.signal]);
  /** @type {SourceError[]} */
  const errors = [];
  /** @type {string[]} */
  const queried = [];
  for (const source of requested) {
    if (!SOURCES.includes(source)) errors.push({ source, error: "unknown source" });
    else if (!queried.includes(source)) queried.push(source);
  }
  try {
    const completed = await Promise.all(queried.map(async source => {
      try { return { source, records: await fetchSource(source, query, limit, timeout, context, signal, fetchFn) }; }
      catch (error) { return { source, records: [], error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 500) : "Academic source failed" }; }
    }));
    signal.throwIfAborted();
    if (Date.now() >= context.deadline) throw new DOMException("Academic call deadline expired", "TimeoutError");
    /** @type {AcademicRecord[]} */
    const results = [];
    const seen = new Set();
    for (const source of completed) {
      if (source.error) errors.push({ source: source.source, error: source.error });
      for (const item of source.records) {
        const key = item.doi ? `doi:${item.doi}` : `title:${clean(item.title).toLowerCase()}`;
        if (!item.title && !item.doi || seen.has(key)) continue;
        seen.add(key);
        results.push(item);
      }
    }
    /** @type {SearchResult} */
    return { query, sources_queried: queried, count: results.length, results, errors };
  } finally { clearTimeout(timer); }
}

/** @type {import('@vykor/plugins/sdk').NativeToolDefinition[]} */
export const academicTools = [{
  name: "KnowledgeAcademicSearch",
  description: "并行检索 arxiv、OpenAlex、Crossref、Semantic Scholar、PubMed，返回真实摘要、作者、日期、DOI 与链接；各来源失败分别报告。摘要不是论文全文；单次响应最多5MB，每来源最多25条、每条最多10位作者。只访问已批准的固定 HTTPS 学术 API。",
  safeToRetry: true,
  inputSchema: {
    type: "object", required: ["query"], additionalProperties: false,
    properties: {
      query: { type: "string", minLength: 1, maxLength: 2000 },
      limit: { type: "integer", description: "每个来源的结果数，默认5，夹到1–25。" },
      sources: { description: "来源名数组，或逗号分隔字符串；默认全部五个来源。", items: { type: "string", maxLength: 80 }, maxItems: 20 },
      timeout: { type: "number", description: "单次请求超时秒数，默认30，夹到1–60；宿主调用截止时间仍优先。" },
    },
  },
  async invoke(input, context) {
    /** @type {string[]} */ const storageIssues = [];
    /** @type {AcademicFetch} */
    const trackedFetch = async (url, options) => {
      /** @type {HttpResponse|undefined} */ let response;
      try { response = await globalThis.fetch(url, options); return response; }
      finally {
        try { await appendResearchAttempts(context, [{ kind: "fetch", tool: "KnowledgeAcademicSearch", url: url.href,
          request_id: randomUUID(),
          status: response?.ok ? "ok" : "failed", http_status: response?.status, recorded_at: new Date().toISOString() }]); }
        catch { storageIssues.push("request_ledger_write_failed"); }
      }
    };
    const data = await searchAcademic(input, context, trackedFetch);
    const results = [];
    for (const source of data.results) {
      try { results.push({ ...source, source_ref: await saveResearchSource(context, { ...source, origin: "academic_retrieval" }) }); }
      catch { storageIssues.push("source_record_write_failed"); results.push(source); }
    }
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: { ...data, results, storage_issues: [...new Set(storageIssues)] } }) }] };
  },
}];

/** @type {import('@vykor/plugins/sdk').NativeToolRegister} */
export const registerTools = () => academicTools;
