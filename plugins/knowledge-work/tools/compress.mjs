// Adapted from Orkas deep-research compress.py; see ../THIRD-PARTY-NOTICES.md.
/** @typedef {{id:string,text:string,url?:string|null,title?:string|null,path?:string|null,source?:string|null,source_type?:string|null,date?:string|null,doi?:string|null,pmid?:string|null,authors?:string[],source_ref?:string,text_truncated?:boolean,accessed_at?:string}} Source */
/** @typedef {{source:string,url:string|null,title:string|null,path?:string|null,source_type?:string|null,date?:string|null,doi?:string|null,pmid?:string|null,authors?:string[],source_ref?:string,text_truncated?:boolean,accessed_at?:string,chunk:string,chunk_index:number,score?:number|null,_density?:number}} Chunk */

const MAX_SOURCES = 200;
const MAX_SOURCE_CHARS = 100000;
const MAX_TOTAL_INPUT_CHARS = 500000;
const MAX_CHUNK_CHARS = 1200;
const MIN_CHUNK_CHARS = 80;
const SMALL_CONTENT_CHARS = 2000;
const DEFAULT_MAX_CHARS = 12000;
const STOP_WORDS = new Set("the and for with your you our are that this from what how why can all any into out get was were has have had not but its their them they will would which who whom these those such than then there here when where about over more most some also may might been being does did a an of to in is it on by or be as at".split(" "));
const CJK_STOP_WORDS = new Set(["什么", "如何", "是否", "哪些", "这个", "那个", "可以", "需要", "以及", "对于", "进行", "一个", "一种", "我们", "他们", "其中", "相关"]);
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/gu;
const CRITICAL_SIGNALS = /\b(?:no|not|never|neither|nor|without|cannot|[a-z]+n['’]t|unsupported|unavailable|unverified|unproven|unable|disallowed|excluded|prohibited|only|if|unless|except|provided|assuming|when|until|subject to|at least|at most|up to)\b|不|未|无|仅|只|除外|例外|如果|除非|假如|条件|前提|限制|\d+(?:[.,]\d+)*/giu;

/** Count Unicode code points, matching Python character budgets, not UTF-16 units.
 * @param {string} text */
function chars(text) { let count = 0; for (const _ of text) count++; return count; }
/** @param {string} text @param {number} limit */
function cut(text, limit) { return [...text].slice(0, limit).join(""); }
/** @param {string} text */
function fold(text) { return text.normalize("NFKC").toLowerCase().replaceAll("ß", "ss").replaceAll("ς", "σ"); }
/** @param {string} text */
function normalized(text) { return fold(text).replace(/\s+/gu, " ").trim(); }

/** @param {unknown} value @param {string} label @param {number} fallback */
function number(value, label, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new TypeError(`${label} must be a finite safe number`);
  }
  return value;
}

/** @param {string} text @returns {string[]} */
function tokenize(text) {
  const value = text.normalize("NFKC");
  const terms = [...value.matchAll(/[0-9A-Za-z][0-9A-Za-z'\-]*/gu)]
    .map(match => match[0].toLowerCase()).filter(word => word.length >= 2 && !STOP_WORDS.has(word));
  for (const match of value.matchAll(CJK)) {
    const run = [...match[0]];
    if (run.length === 1) terms.push(match[0]);
    else for (let index = 0; index < run.length - 1; index++) {
      const token = run.slice(index, index + 2).join("");
      if (!CJK_STOP_WORDS.has(token)) terms.push(token);
    }
  }
  return terms;
}

/** @param {string} text */
function effectiveLength(text) {
  let cjk = 0;
  for (const match of text.matchAll(CJK)) cjk += chars(match[0]);
  return chars(text) + 2 * cjk;
}

/** Split original evidence into passages; normalize only its layout whitespace.
 * @param {string} text @param {number} maxChars @returns {string[]} */
function chunks(text, maxChars) {
  const cap = Math.max(MIN_CHUNK_CHARS, Math.min(Math.trunc(maxChars), MAX_CHUNK_CHARS));
  /** @type {string[]} */ const result = [];
  for (const raw of text.split(/\n\s*\n/u)) {
    const paragraph = raw.replace(/\s+/gu, " ").trim();
    if (!paragraph) continue;
    if (chars(paragraph) <= cap) {
      if (effectiveLength(paragraph) >= MIN_CHUNK_CHARS) result.push(paragraph);
      continue;
    }
    let buffer = "";
    // Keep actual separators with each sentence. Inserting a space between
    // Chinese or unspaced Latin sentences would manufacture a new quotation.
    for (const sentence of paragraph.match(/[^.!?。！？；]*[.!?。！？；]\s*|[^.!?。！？；]+$/gu) ?? []) {
      if (!sentence.trim()) continue;
      if (buffer && chars(buffer) + chars(sentence) > cap) {
        if (effectiveLength(buffer.trim()) >= MIN_CHUNK_CHARS) result.push(buffer.trim());
        buffer = sentence;
      } else buffer += sentence;
      if (chars(buffer) > cap) {
        const points = [...buffer];
        let offset = 0;
        while (points.length - offset > cap) {
          result.push(points.slice(offset, offset + cap).join("").trim());
          offset += cap;
        }
        buffer = points.slice(offset).join("");
      }
    }
    if (effectiveLength(buffer.trim()) >= MIN_CHUNK_CHARS) result.push(buffer.trim());
  }
  return result;
}

/** @param {Set<string>} terms */
function dedupKeys(terms) {
  const ordered = [...terms].sort();
  if (!ordered.length) return [];
  if (ordered.length <= 8) return [ordered.join(" ")];
  const keys = [];
  for (let index = 0; index <= ordered.length - 8; index += 4) keys.push(ordered.slice(index, index + 8).join(" "));
  const tail = ordered.slice(-8).join(" ");
  if (keys.at(-1) !== tail) keys.push(tail);
  return keys;
}

/** Keep potentially material differences before using a lexical similarity score.
 * Small surrounding excerpts retain which quantity or condition each signal modifies;
 * this is a conservative textual guard, not a test of semantic equivalence.
 * @param {string} text */
function criticalSignature(text) {
  const value = normalized(text);
  const signals = [...value.matchAll(CRITICAL_SIGNALS)].map(match =>
    value.slice(Math.max(0, match.index - 16), match.index + match[0].length + 32));
  return JSON.stringify(signals.sort());
}

/** @param {Chunk[]} records */
function deduplicate(records) {
  const seen = new Set();
  /** @type {Chunk[]} */ const kept = [];
  /** @type {Set<string>[]} */ const keptTokens = [];
  /** @type {string[]} */ const keptSignals = [];
  /** @type {Map<string, number[]>} */ const buckets = new Map();
  let dropped = 0;
  for (const record of records) {
    const key = normalized(record.chunk);
    if (seen.has(key)) { dropped++; continue; }
    const terms = new Set(tokenize(record.chunk));
    const signals = criticalSignature(record.chunk);
    const keys = dedupKeys(terms);
    const candidates = new Set(keys.flatMap(bucket => buckets.get(bucket) ?? []));
    let near = false;
    for (const index of candidates) {
      if (keptSignals[index] !== signals) continue;
      const previous = keptTokens[index];
      if (!previous) continue;
      let overlap = 0;
      for (const token of terms) if (previous.has(token)) overlap++;
      if (overlap && overlap / (terms.size + previous.size - overlap) >= 0.9) { near = true; break; }
    }
    if (near) { dropped++; continue; }
    seen.add(key); kept.push(record); keptTokens.push(terms); keptSignals.push(signals);
    for (const bucket of keys) {
      const entries = buckets.get(bucket) ?? [];
      entries.push(keptTokens.length - 1); buckets.set(bucket, entries);
    }
  }
  return { kept, dropped };
}

/** @param {Set<string>} query @param {string[]} terms @returns {[number,number]} */
function score(query, terms) {
  if (!query.size || !terms.length) return [0, 0];
  const present = new Set(terms);
  const matched = new Set([...query].filter(term => present.has(term)));
  if (!matched.size) return [0, 0];
  const hits = terms.filter(term => matched.has(term)).length;
  return [Math.round(matched.size / query.size * 10000) / 10000, Math.round(hits / terms.length * 10000) / 10000];
}

/** @param {Chunk[]} records @param {number} budget @param {number|null} perSource */
function select(records, budget, perSource) {
  /** @type {Chunk[]} */ const kept = [];
  /** @type {Map<string, number>} */ const counts = new Map();
  let used = 0;
  for (const record of records) {
    const count = counts.get(record.source) ?? 0;
    if (perSource !== null && count >= perSource) continue;
    const size = chars(record.chunk);
    if (!size || used + size > budget) continue;
    kept.push(record); used += size; counts.set(record.source, count + 1);
  }
  return kept;
}

/** @param {unknown[]} input */
function limitSources(input) {
  /** @type {Source[]} */ const sources = [];
  let rawChars = 0, consideredChars = 0, dropped = 0, truncated = 0, charsTruncated = 0;
  for (const value of input) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("source must be an object");
    const source = /** @type {Source} */ (value);
    if (typeof source.id !== "string" || !source.id || typeof source.text !== "string") throw new TypeError("source id and text must be strings");
    for (const key of ["url", "title", "path", "source", "source_type", "date", "doi", "pmid", "accessed_at"]) {
      const field = /** @type {Record<string, unknown>} */ (value)[key];
      if (field != null && typeof field !== "string") throw new TypeError(`source ${key} must be a string`);
    }
    if (source.source_ref !== undefined && (typeof source.source_ref !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(source.source_ref))) throw new TypeError("source_ref must be a plugin source UUID");
    if (source.text_truncated !== undefined && typeof source.text_truncated !== "boolean") throw new TypeError("text_truncated must be a boolean");
    if (source.authors !== undefined && (!Array.isArray(source.authors) || source.authors.length > 20
      || source.authors.some(author => typeof author !== "string"))) throw new TypeError("source authors must contain at most 20 strings");
    const originalSize = chars(source.text);
    rawChars += originalSize;
    if (sources.length >= MAX_SOURCES || consideredChars >= MAX_TOTAL_INPUT_CHARS) {
      dropped++; charsTruncated += originalSize; continue;
    }
    const cap = Math.min(MAX_SOURCE_CHARS, MAX_TOTAL_INPUT_CHARS - consideredChars);
    const text = originalSize > cap ? cut(source.text, cap) : source.text;
    const size = Math.min(originalSize, cap);
    if (size < originalSize) { truncated++; charsTruncated += originalSize - size; }
    sources.push({ ...source, text }); consideredChars += size;
  }
  return { sources, stats: {
    sources_input: input.length, sources_considered: sources.length,
    sources_dropped: dropped, sources_truncated: truncated,
    chars_input_raw: rawChars, chars_truncated: charsTruncated,
    input_capped: dropped > 0 || truncated > 0,
  } };
}

/** Retain evidence by lexical relevance, deduplication and strict character/source budgets.
 * Pure local processing; chunk text is evidence, never an AI-generated summary.
 * @param {Record<string, unknown>} input */
export function compressEvidence(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("input must be an object");
  const raw = input.sources ?? [];
  if (!Array.isArray(raw) || raw.length > 10000) throw new TypeError("sources must be an array within 10000 items");
  const query = input.query ?? "";
  if (typeof query !== "string" || chars(query) > 4000) throw new TypeError("query must be a string within 4000 characters");
  const { sources, stats } = limitSources(raw);
  const budget = Math.max(0, Math.min(Math.trunc(number(input.max_chars, "max_chars", DEFAULT_MAX_CHARS)), MAX_TOTAL_INPUT_CHARS));
  const perSource = input.max_per_source == null ? null : Math.max(0, Math.trunc(number(input.max_per_source, "max_per_source", 0)));
  const minScore = number(input.min_score, "min_score", 0);
  if (minScore < 0 || minScore > 1) throw new TypeError("min_score must be within 0 and 1");
  const charsIn = sources.reduce((sum, source) => sum + chars(source.text), 0);
  const queryTerms = new Set(tokenize(query));
  const skip = charsIn <= SMALL_CONTENT_CHARS && charsIn <= budget;
  /** @type {Chunk[]} */ const records = [];
  for (const source of sources) {
    const cap = Math.max(MIN_CHUNK_CHARS, Math.min(MAX_CHUNK_CHARS, budget || MAX_CHUNK_CHARS));
    const pieces = skip ? [source.text.trim()] : chunks(source.text, cap);
    for (const [index, piece] of pieces.entries()) {
      if (!piece) continue;
      records.push({ source: source.id, url: source.url ?? null, title: source.title ?? null,
        ...(source.path !== undefined ? { path: source.path } : {}),
        ...(source.source_type !== undefined || source.source !== undefined ? { source_type: source.source_type ?? source.source } : {}),
        ...(source.date !== undefined ? { date: source.date } : {}),
        ...(source.doi !== undefined ? { doi: source.doi } : {}),
        ...(source.pmid !== undefined ? { pmid: source.pmid } : {}),
        ...(source.authors !== undefined ? { authors: [...source.authors] } : {}),
        ...(source.source_ref !== undefined ? { source_ref: source.source_ref } : {}),
        ...(source.text_truncated !== undefined ? { text_truncated: source.text_truncated } : {}),
        ...(source.accessed_at !== undefined ? { accessed_at: source.accessed_at } : {}),
        chunk: piece, chunk_index: index });
    }
  }
  const { kept: unique, dropped: deduped } = deduplicate(records);
  let droppedLow = 0;
  /** @type {Chunk[]} */ let ranked = unique;
  if (!skip && queryTerms.size) {
    ranked = unique.map(record => {
      const [coverage, density] = score(queryTerms, tokenize(record.chunk));
      return { ...record, score: coverage, _density: density };
    });
    ranked.sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || (right._density ?? 0) - (left._density ?? 0)
      || (left.source < right.source ? -1 : left.source > right.source ? 1 : 0) || left.chunk_index - right.chunk_index);
    const relevant = ranked.filter(record => (record.score ?? 0) > minScore);
    droppedLow = ranked.length - relevant.length; ranked = relevant;
  }
  const kept = select(ranked, budget, perSource).map(({ _density, ...record }) => ({ ...record, score: record.score ?? null }));
  const charsOut = kept.reduce((sum, record) => sum + chars(record.chunk), 0);
  return {
    query, kept, dropped_low_relevance: droppedLow, budget_chars: budget,
    stats: {
      sources: stats.sources_input, ...stats, chunks_total: unique.length + deduped,
      chunks_kept: kept.length, chars_in: charsIn, chars_out: charsOut, deduped,
      skipped_compression: skip, skipped_scoring: !skip && !queryTerms.size,
    },
  };
}

/** @type {import('@vykor/plugins/sdk').NativeToolDefinition[]} */
export const compressionTools = [{
  name: "KnowledgeEvidenceCompress",
  description: "按问题对长来源原文切片、去重、排序，在字符及每来源预算内保留证据。支持中文及英文，保留来源和片段位置，不联网、不读写文件、不生成摘要。",
  safeToRetry: true,
  inputSchema: {
    type: "object", required: ["sources"], additionalProperties: false,
    properties: {
      query: { type: "string", maxLength: 4000 },
      max_chars: { type: "number", minimum: 0, maximum: 500000 },
      max_per_source: { type: ["number", "null"], minimum: 0, maximum: 10000 },
      min_score: { type: "number", minimum: 0, maximum: 1 },
      sources: { type: "array", maxItems: 400, items: {
        type: "object", required: ["id", "text"], additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: 2000 },
          text: { type: "string", maxLength: 200000 },
          url: { type: ["string", "null"], maxLength: 2000 },
          title: { type: ["string", "null"], maxLength: 60000 },
          path: { type: ["string", "null"], maxLength: 2000 },
          source: { type: ["string", "null"], maxLength: 80 },
          source_type: { type: ["string", "null"], maxLength: 80 },
          date: { type: ["string", "null"], maxLength: 100 },
          doi: { type: ["string", "null"], maxLength: 2000 },
          pmid: { type: ["string", "null"], maxLength: 100 },
          authors: { type: "array", maxItems: 20, items: { type: "string", maxLength: 500 } },
          source_ref: { type: "string", minLength: 36, maxLength: 36,
            pattern: "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$" },
          text_truncated: { type: "boolean" },
          accessed_at: { type: "string", maxLength: 64 },
        },
      } },
    },
  },
  invoke(input, context) {
    context.signal.throwIfAborted();
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: compressEvidence(input) }) }] };
  },
}];
