// Adapted from Orkas research_gate.py and audit_content.py (MIT).
// Copyright (c) 2026 Orkas contributors. See ../THIRD-PARTY-NOTICES.md.
import { createHash } from "node:crypto";

const GATE_MAX_BYTES = 1024 * 1024;
const AUDIT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_FINDINGS = 1000;
const MAX_LINKS = 5000;
const MAX_COMPARISON_VALUES = 1000;

/** @typedef {'error'|'review'|'suggestion'} Severity */
/** @typedef {{code:string,severity:Severity,line:number,message:string,excerpt:string,metadata?:Record<string,unknown>}} Finding */
/** @typedef {{line:number,label:string,url:string}} Link */

/** @param {unknown} value @param {string} label @returns {Record<string,unknown>} */
function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return /** @type {Record<string,unknown>} */ (value);
}

/** @param {unknown} value */
function normalizeFamily(value) {
  // NFKC covers compatibility variants; these two case-fold expansions retain
  // the source script's common caseless family aliases beyond toLowerCase().
  const family = String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase().replace(/ß/gu, "ss").replace(/ς/gu, "σ");
  if (!family) throw new TypeError("family labels cannot be empty");
  if (/\p{C}/u.test(family)) throw new TypeError("family labels cannot contain control characters");
  const chars = Array.from(family);
  return chars.length > 64 ? `${chars.slice(0, 55).join("")}-${createHash("sha256").update(family).digest("hex").slice(0, 8)}` : family;
}

/** @param {unknown} value */
function normalizeSourceUrl(value) {
  const raw = String(value || "").trim();
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) throw new TypeError("usable sources require an absolute http(s) URL without credentials");
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/u, "") || "/";
  const firstSegment = path.split("/").find(Boolean)?.toLowerCase() ?? "";
  if (["baike.baidu.com", "baike.com", "wikipedia.org"].includes(host) || host.endsWith(".wikipedia.org") || host.includes("encyclopedia") || path === "/" || ["search", "tag", "tags", "category", "categories"].includes(firstSegment)) throw new TypeError("usable sources require a specific non-encyclopedia page");
  return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
}

/** @param {unknown} value */
function publishedDate(value) {
  const raw = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(raw);
  if (!match) return "";
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0) ? raw : "";
}

/** Collection coverage only; recorded status/date do not prove retrieval or truth. @param {unknown} input */
export function evaluateResearchLedger(input) {
  const payload = record(input, "ledger root");
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > GATE_MAX_BYTES) throw new RangeError(`input exceeds ${GATE_MAX_BYTES} UTF-8 bytes`);
  const minimum = payload.min_sources ?? 1;
  if (typeof minimum !== "number" || !Number.isInteger(minimum) || minimum < 1 || minimum > 20) throw new RangeError("min_sources must be between 1 and 20");
  if (!Array.isArray(payload.required_families) || !payload.required_families.length) throw new TypeError("required_families must be a non-empty array");
  if (payload.required_families.length > 50) throw new RangeError("required_families exceeds 50");
  const required = [...new Set(payload.required_families.map(normalizeFamily))];
  const rows = payload.sources ?? [];
  if (!Array.isArray(rows)) throw new TypeError("sources must be an array");
  if (rows.length > 100) throw new RangeError("sources exceeds 100");
  /** @type {Map<string,Set<string>>} */
  const usable = new Map();
  const dated = new Set();
  let undatedRows = 0, rejectedRows = 0, disallowedRows = 0, malformedRows = 0;
  for (const raw of rows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { rejectedRows++; continue; }
    const row = /** @type {Record<string,unknown>} */ (raw);
    if (String(row.status ?? "").trim().toLowerCase() !== "usable") { rejectedRows++; continue; }
    let url;
    try { url = normalizeSourceUrl(row.url); } catch { disallowedRows++; continue; }
    if (!Array.isArray(row.families) || !row.families.length) { malformedRows++; continue; }
    let families;
    try { families = new Set(row.families.map(normalizeFamily)); } catch { malformedRows++; continue; }
    const merged = usable.get(url) ?? new Set();
    for (const family of families) merged.add(family);
    usable.set(url, merged);
    if (publishedDate(row.published)) { for (const family of families) dated.add(family); }
    else undatedRows++;
  }
  const covered = new Set([...usable.values()].flatMap((families) => [...families]));
  const missing = required.filter((family) => !covered.has(family));
  const undated = required.filter((family) => covered.has(family) && !dated.has(family));
  const eligible = usable.size >= minimum;
  const ready = eligible && missing.length === 0;
  const reasons = [], advisories = [];
  if (!eligible) reasons.push(`need ${minimum - usable.size} more distinct usable source(s) for the requested evidence standard`);
  if (missing.length) reasons.push(`missing evidence families: ${missing.join(", ")}`);
  if (undated.length) advisories.push(`families whose sources state no publication date: ${undated.join(", ")}; assess whether each retained claim needs a dated source`);
  if (disallowedRows) reasons.push(`ignored ${disallowedRows} disallowed or generic source row(s)`);
  if (malformedRows) reasons.push(`ignored ${malformedRows} malformed usable source row(s)`);
  return {
    ok: true, ready, decision: ready ? "READY_TO_DRAFT" : "CONTINUE_RESEARCH", gate_eligible: eligible,
    minimum_distinct_sources: minimum, usable_source_count: usable.size,
    required_families: required, covered_families: required.filter((family) => covered.has(family)),
    missing_families: missing, undated_families: undated, undated_source_rows: undatedRows,
    ignored_nonusable_rows: rejectedRows, ignored_disallowed_source_rows: disallowedRows,
    ignored_malformed_source_rows: malformedRows, reasons, advisories,
    limits: "Collection coverage only; a recorded date is taken at face value and an undated row is not automatically blocking. Separately decide whether the claim needs dated evidence and verify fetch success, source quality, quote provenance, claim entailment, independence, and freshness. Distinct URLs do not prove independent evidence.",
  };
}

const URL_RE = /https?:\/\/[^\s<>()\[\]{}]+/iu;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/iu;
const CITATION_MARKER_RE = /(?:\[(?:\d{1,3}|[A-Za-z]\d{1,3}|\^[A-Za-z0-9_-]+)\]|\([A-Z][A-Za-z'’-]+(?:\s+(?:et\s+al\.|and\s+[A-Z][A-Za-z'’-]+))?,?\s+20\d{2}[a-z]?\))/u;
const PLACEHOLDER_RE = /(?:\b(?:TODO|TBD|TK|FIXME|XXX)\b|\[(?:citation needed|source needed|verify|待补|待核|来源|引用)\]|\{\{[^{}]+\}\}|<<[^<>]+>>)/iu;
const NUMERIC_CLAIM_RE = /(?:[$€£¥￥]\s?\d|(?<!\d)(?:19|20)\d{2}(?!\d)|(?<![\d.])\d+(?:[.,]\d+)?\s?(?:%|percent|percentage points?|bps|x|million|billion|trillion|万|亿|倍|个百分点|亿元?|万元?|美元|元|人|名|家|个|天|年|个月|hours?|days?|weeks?|months?|years?|ms|seconds?|GB|TB|MB)(?![A-Za-z0-9]))/iu;
const QUOTE_RE = /(?:"[^"\n]{12,}"|“[^”\n]{12,}”|‘[^’\n]{12,}’|「[^」\n]{12,}」|『[^』\n]{12,}』)/u;
const LATIN_WORD_RE = /[A-Za-zÀ-ÖØ-öø-ÿ0-9]+(?:[’'-][A-Za-zÀ-ÖØ-öø-ÿ0-9]+)*/u;
const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/u;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/u;
const TABLE_SEPARATOR_RE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/u;
const DISCLOSURE_RE = /(?:赞助|资助|广告|商业合作|利益冲突|关联链接|affiliate|sponsor(?:ed by)?|funder|funded by|conflict of interest|paid partnership)/iu;
const DISCLOSURE_PARTY_PATTERNS = [
  /(?:sponsored|funded)\s+by\s+([A-Za-z0-9][A-Za-z0-9 .&'’_-]{0,79}?)(?=\s*(?:[.,;:!?)]|$))/iu,
  /(?:由|获)\s*([\p{L}\p{N}_][\p{L}\p{N}_ .&'’()_-]{0,79}?)\s*(?:赞助|资助)/iu,
  /(?:sponsor|funder|赞助方|资助方)\s*[:：]\s*([A-Za-z0-9\u3400-\u4dbf\u4e00-\u9fff][A-Za-z0-9\u3400-\u4dbf\u4e00-\u9fff .&'’()_-]{0,79}?)(?=\s*(?:[.,;:!?，。；：！？)]|$))/iu,
];
const BRIDGE_CLAIM_PATTERNS = {
  foundation: /(?:提供|奠定|打下).{0,12}基础|(?:provide|lay|form).{0,20}(?:a |the )?(?:foundation|basis)/iu,
  signal_or_potential: /初步(?:信号|迹象)|展现.{0,10}潜力|显示.{0,10}潜力|shows?.{0,16}potential|early signal/iu,
  future_value: /未来(?:价值|可期|潜力|机会)|开启.{0,12}(?:可能|未来)|future (?:value|potential|opportunity)|possibilities are endless/iu,
  unsupported_next_step: /后续(?:如需|需要|应当)|下一步(?:需要|应当)|进一步(?:评估|验证|研究)|more (?:samples|evidence).{0,24}(?:needed|required)|further (?:validation|evaluation|research)/iu,
  effectiveness_inference: /证明.{0,16}(?:有效|效果)|说明.{0,16}(?:有效|效果)|demonstrates?.{0,20}(?:effective|effectiveness)/iu,
};
/** @type {Record<string,[RegExp,string]>} */
const STYLE_PATTERNS = {
  significance_inflation: [/\b(?:pivotal|transformative|groundbreaking|a testament to|marks? a (?:major |key )?(?:shift|turning point|milestone)|underscores? (?:the |its )?importance|evolving landscape)\b|(?:标志着|彰显了|具有里程碑意义|划时代|历史性时刻|时代浪潮)/iu, "Check whether significance language states a supported consequence or merely inflates importance."],
  promotional_language: [/\b(?:breathtaking|must-visit|best-in-class|world-class|revolutionary|unparalleled|game-changing|seamless(?:ly)?|unlock(?:s|ing)? the power)\b|(?:行业领先|颠覆性|革命性|无与伦比|极致体验|强势赋能|重磅|震撼发布|遥遥领先)/iu, "Replace promotional language with a specific supported attribute unless the channel intentionally calls for ad copy."],
  vague_attribution: [/\b(?:experts (?:say|believe|argue)|studies (?:show|suggest|indicate)|research (?:shows|suggests)|industry reports? (?:say|show|suggest)|observers (?:say|note|believe)|many people believe)\b|(?:专家(?:表示|认为|指出)|研究(?:表明|显示|发现)|业内人士(?:表示|认为)|有观点认为|有报道称|数据显示)/iu, "Name and cite the source, or remove the implied authority."],
  generic_signposting: [/\b(?:let(?:'s| us) (?:dive|delve|explore)|here(?:'s| is) what you need to know|in today(?:'s|’s) (?:fast-paced|rapidly changing) world|without further ado)\b|(?:让我们(?:深入|一起来)(?:探讨|了解|看看)|下面(?:让我们|我们将)|在当今(?:快速发展|瞬息万变)的时代|话不多说)/iu, "Start with the useful point unless the signpost serves a real navigation need."],
  chatbot_residue: [/\b(?:i hope this helps|let me know if you(?:'d| would) like|would you like me to|of course!|great question!)\b|(?:希望(?:这些|以上内容)?对你有帮助|如果你愿意我可以|如需更多帮助|这是一个很好的问题)/iu, "Remove assistant-to-user correspondence that is not part of the artifact."],
  generic_conclusion: [/\b(?:the future (?:looks|is) bright|only time will tell|the possibilities are endless|an exciting journey ahead)\b|(?:展望未来|未来可期|让我们拭目以待|未来充满无限可能)/iu, "End with a supported implication, decision, uncertainty, or next action."],
  forced_parallelism: [/\b(?:it(?:'s| is) not (?:just|only).{0,80}\bit(?:'s| is)|not only.{0,100}but also)\b|(?:不仅仅?是.{0,80}(?:更是|而是)|不只是.{0,80}(?:更是|而是))/iu, "Check whether the contrast adds meaning or is formulaic framing."],
};
const SEVERITY_ORDER = { error: 0, review: 1, suggestion: 2 };

/** @param {RegExp} pattern @param {string} text */
function matches(pattern, text) { return text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`)); }
/** @param {string} text */
function lines(text) { const result = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u); if (result.at(-1) === "") result.pop(); return result; }
/** @param {string} text */
function maskCode(text) {
  let fence = "";
  return lines(text).map((line) => {
    const marker = line.trimStart().slice(0, 3);
    if (fence) { if (marker === fence) fence = ""; return ""; }
    if (marker === "```" || marker === "~~~") { fence = marker; return ""; }
    return line.replace(/`[^`\n]+`/gu, "");
  }).join("\n");
}
/** @param {string} line */
function hasCitation(line) { return URL_RE.test(line) || MARKDOWN_LINK_RE.test(line) || CITATION_MARKER_RE.test(line); }
/** @param {string} text */
function excerpt(text) { const compact = text.replace(/\s+/gu, " ").trim(); const chars = Array.from(compact); return chars.length <= 180 ? compact : `${chars.slice(0, 179).join("").trimEnd()}…`; }
/** @param {string} line */
function sentences(line) {
  return line.split(/(?<=[.!?。！？])\s+|(?<=[。！？])/u).map((text) => text.trim()).filter(Boolean).map((text) => ({ text, latin: [...matches(LATIN_WORD_RE, text)].length, han: [...matches(HAN_RE, text)].length }));
}
/** @param {string} title */
function titleCase(title) {
  const stopwords = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to"]);
  const words = [...matches(/[A-Za-z][A-Za-z'’-]*/u, title.replace(/[*_`]+/gu, ""))].map((match) => match[0]).filter((word) => !stopwords.has(word.toLowerCase()));
  return { total: words.length, ratio: words.length ? words.filter((word) => /^[A-Z]/u.test(word)).length / words.length : 0 };
}
/** @param {string} value */
function compactValue(value) { return value.replace(/\s+/gu, "").toLowerCase(); }
/** @param {RegExp} pattern @param {string} text @returns {Map<string,number>} */
function normalizedMatches(pattern, text) {
  const counts = new Map();
  for (const match of matches(pattern, maskCode(text))) { const value = compactValue(match[0]); counts.set(value, (counts.get(value) ?? 0) + 1); }
  return counts;
}
/** @param {string} text @returns {Map<string,number>} */
function disclosureParties(text) {
  const parties = new Map();
  for (const line of lines(maskCode(text))) {
    if (!DISCLOSURE_RE.test(line)) continue;
    const seen = new Set();
    for (const pattern of DISCLOSURE_PARTY_PATTERNS) for (const match of matches(pattern, line)) {
      const party = (match[1] ?? "").replace(/\s+/gu, " ").replace(/^[\s.,;:!?，。；：！？()]+|[\s.,;:!?，。；：！？()]+$/gu, "").toLowerCase();
      if (party && !seen.has(party)) { parties.set(party, (parties.get(party) ?? 0) + 1); seen.add(party); }
    }
  }
  return parties;
}
/** @param {Map<string,number>} first @param {Map<string,number>} second */
function difference(first, second) {
  /** @type {string[]} */
  const values = [];
  let total = 0;
  for (const [value, count] of first) {
    const remaining = Math.max(0, count - (second.get(value) ?? 0));
    total += remaining;
    const take = Math.min(remaining, MAX_COMPARISON_VALUES - values.length);
    for (let i = 0; i < take; i++) values.push(value);
  }
  return { values, total, truncated: total > values.length };
}
/** @param {string} text @param {string} value */
function firstLineWith(text, value) { const raw = lines(text); const index = raw.findIndex((line) => compactValue(line).includes(compactValue(value))); return { line: index < 0 ? 1 : index + 1, text: raw[index < 0 ? 0 : index] ?? "" }; }
/** @param {unknown} value @param {string} label @returns {string} */
function validateText(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  if (value.length > AUDIT_MAX_BYTES || Buffer.byteLength(value, "utf8") > AUDIT_MAX_BYTES) throw new RangeError(`${label} exceeds ${AUDIT_MAX_BYTES} UTF-8 bytes`);
  return value;
}

/** Heuristic editorial candidates; no factual/publication pass is inferred. @param {unknown} input */
export function auditContent(input) {
  const payload = record(input, "audit input");
  const text = validateText(payload.text, "input");
  const source = payload.source_text === undefined ? undefined : validateText(payload.source_text, "source input");
  const maximum = payload.max_findings ?? 100;
  if (typeof maximum !== "number" || !Number.isInteger(maximum) || maximum < 1 || maximum > MAX_FINDINGS) throw new RangeError(`max_findings must be between 1 and ${MAX_FINDINGS}`);
  const maxFindings = maximum;
  const clean = maskCode(text), rawLines = lines(text), cleanLines = lines(clean);
  /** @type {Record<Severity,Finding[]>} */
  const buckets = { error: [], review: [], suggestion: [] };
  /** @type {Link[]} */
  const links = [];
  let findingsSeen = 0, linksSeen = 0, headings = 0;
  /** @param {string} code @param {Severity} severity @param {number} line @param {string} message @param {string} raw @param {Record<string,unknown>} [metadata] */
  function add(code, severity, line, message, raw, metadata) {
    findingsSeen++;
    if (buckets[severity].length < maxFindings) buckets[severity].push({ code, severity, line, message, excerpt: excerpt(raw), ...(metadata ? { metadata } : {}) });
  }
  /** @param {number} line @param {string} label @param {string} url */
  function addLink(line, label, url) { linksSeen++; if (links.length < MAX_LINKS) links.push({ line, label, url }); }
  for (const [index, line] of cleanLines.entries()) {
    if (!line.trim() || TABLE_SEPARATOR_RE.test(line)) continue;
    const number = index + 1, raw = rawLines[index] ?? line, heading = HEADING_RE.exec(line);
    if (heading) {
      headings++;
      const casing = titleCase(heading[2] ?? "");
      if (casing.total >= 4 && casing.ratio >= 0.8) add("title_case_heading", "suggestion", number, "Check whether title case matches the channel and house style.", raw, { title_case_ratio: Math.round(casing.ratio * 100) / 100 });
    }
    const markdownUrls = new Set();
    for (const match of matches(MARKDOWN_LINK_RE, line)) { addLink(number, match[1] ?? "", match[2] ?? ""); markdownUrls.add(match[2]); }
    for (const match of matches(URL_RE, line)) { const url = match[0].replace(/[.,;:!?，。；：！？]+$/gu, ""); if (!markdownUrls.has(url)) addLink(number, "", url); }
    for (const match of matches(PLACEHOLDER_RE, line)) add("unresolved_placeholder", "error", number, "Resolve the placeholder before publication.", raw, { placeholder: match[0] });
    if (NUMERIC_CLAIM_RE.test(line)) add("numeric_or_date_claim", "review", number, "Verify the number/date, scope, unit, freshness, and source entailment.", raw, { citation_marker_present: hasCitation(line) });
    if (QUOTE_RE.test(line)) add("direct_quote_candidate", "review", number, "Verify the exact wording, speaker, date, context, and citation.", raw, { citation_marker_present: hasCitation(line) });
    for (const [code, [pattern, message]] of Object.entries(STYLE_PATTERNS)) if (pattern.test(line)) add(code, code === "vague_attribution" ? "review" : "suggestion", number, message, raw);
    if (!heading) for (const sentence of sentences(line)) if (sentence.latin > 45 || sentence.han > 90) add("long_sentence", "suggestion", number, "Review this long sentence for hierarchy, clarity, and intentional rhythm.", sentence.text, { latin_words: sentence.latin, han_characters: sentence.han });
  }
  /** @type {Map<string,{count:number,line:number,text:string}>} */
  const openers = new Map();
  for (const [index, line] of cleanLines.entries()) {
    if (HEADING_RE.test(line)) continue;
    for (const sentence of sentences(line)) {
      const words = [...matches(LATIN_WORD_RE, sentence.text.toLowerCase())].map((match) => match[0]);
      if (words.length < 4) continue;
      const opener = words.slice(0, 2).join(" "), found = openers.get(opener);
      if (found) found.count++; else openers.set(opener, { count: 1, line: index + 1, text: sentence.text });
    }
  }
  for (const [opener, value] of openers) if (value.count >= 3) add("repeated_sentence_opener", "suggestion", value.line, `The opener '${opener}' appears ${value.count} times; check for mechanical cadence.`, value.text, { count: value.count });
  /** @type {Record<string,unknown>|undefined} */
  let comparison;
  if (source !== undefined) {
    const sourceNumbers = normalizedMatches(NUMERIC_CLAIM_RE, source), candidateNumbers = normalizedMatches(NUMERIC_CLAIM_RE, text);
    const sourceCitations = normalizedMatches(CITATION_MARKER_RE, source), candidateCitations = normalizedMatches(CITATION_MARKER_RE, text);
    const sourceParties = disclosureParties(source), candidateParties = disclosureParties(text);
    const missingNumbers = difference(sourceNumbers, candidateNumbers), addedNumbers = difference(candidateNumbers, sourceNumbers);
    const missingCitations = difference(sourceCitations, candidateCitations), addedCitations = difference(candidateCitations, sourceCitations);
    const missingParties = difference(sourceParties, candidateParties), addedParties = difference(candidateParties, sourceParties);
    /** @type {[ReturnType<typeof difference>,string,string,boolean][]} */
    const changes = [
      [missingNumbers, "source_number_missing", "Restore this source number/date or explicitly document an authorized omission.", true],
      [addedNumbers, "candidate_number_added", "Remove or verify this number/date because it is absent from the supplied source.", false],
      [missingCitations, "source_citation_missing", "Restore the source citation marker next to the claim it supports.", true],
      [addedCitations, "candidate_citation_added", "Remove or verify this citation marker because it is absent from the supplied source.", false],
      [missingParties, "source_disclosure_party_missing", "Restore the disclosed sponsor or funder identity from the supplied source.", true],
      [addedParties, "candidate_disclosure_party_added", "Remove or verify this sponsor or funder identity because it is absent from the supplied source.", false],
    ];
    for (const [change, code, message, removed] of changes) for (const value of change.values) {
      const location = firstLineWith(removed ? source : text, value);
      add(code, "error", location.line, message, location.text, { [removed ? "source_value" : "candidate_value"]: value });
    }
    const cleanSource = maskCode(source), sourceDisclosure = DISCLOSURE_RE.test(cleanSource), candidateDisclosure = DISCLOSURE_RE.test(clean);
    if (sourceDisclosure && !candidateDisclosure) add("source_disclosure_missing", "error", 1, "Restore the sponsorship, funding, advertising, affiliate, or conflict disclosure.", lines(source)[0] ?? "");
    /** @type {{type:string,line:number,text:string}[]} */
    const bridges = [];
    let bridgesSeen = 0;
    for (const [type, pattern] of Object.entries(BRIDGE_CLAIM_PATTERNS)) {
      if (pattern.test(cleanSource)) continue;
      for (const [index, line] of cleanLines.entries()) {
        const match = pattern.exec(line);
        if (!match) continue;
        bridgesSeen++;
        if (bridges.length < MAX_COMPARISON_VALUES) bridges.push({ type, line: index + 1, text: match[0] });
        add("new_bridge_claim", "review", index + 1, "This implication or next-step language is absent from the supplied source; remove it from the artifact or label it as requested editorial advice.", rawLines[index] ?? line, { bridge_type: type });
      }
    }
    comparison = {
      missing_numbers_or_dates: missingNumbers.values, missing_numbers_or_dates_total: missingNumbers.total,
      added_numbers_or_dates: addedNumbers.values, added_numbers_or_dates_total: addedNumbers.total,
      missing_citations: missingCitations.values, missing_citations_total: missingCitations.total,
      added_citations: addedCitations.values, added_citations_total: addedCitations.total,
      missing_disclosure_parties: missingParties.values, missing_disclosure_parties_total: missingParties.total,
      added_disclosure_parties: addedParties.values, added_disclosure_parties_total: addedParties.total,
      source_disclosure_present: sourceDisclosure, candidate_disclosure_present: candidateDisclosure,
      new_bridge_claims: bridges, new_bridge_claims_total: bridgesSeen, new_bridge_claims_truncated: bridgesSeen > bridges.length,
      values_truncated: changes.some(([change]) => change.truncated),
    };
  }
  const findings = Object.values(buckets).flat().sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.line - b.line || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)).slice(0, maxFindings);
  /** @type {Record<string,number>} */
  const severityCounts = {};
  /** @type {Record<string,number>} */
  const codeCounts = {};
  for (const finding of findings) { severityCounts[finding.severity] = (severityCounts[finding.severity] ?? 0) + 1; codeCounts[finding.code] = (codeCounts[finding.code] ?? 0) + 1; }
  const limitations = [
    "Heuristics surface editorial review candidates and can produce false positives.",
    "The audit does not fetch links or verify factual truth, source quality, independence, or claim entailment.",
    "The audit does not detect plagiarism or determine whether a human or model authored the text.",
    "A qualified reviewer must assess high-stakes legal, medical, financial, regulatory, and safety content.",
  ];
  if (comparison) limitations.push("Source comparison is lexical: it checks markers and risky additions, not semantic equivalence or complete claim entailment.");
  return {
    schema_version: 1,
    summary: {
      latin_words: [...matches(LATIN_WORD_RE, clean)].length, han_characters: [...matches(HAN_RE, clean)].length,
      paragraphs: clean.split(/\n\s*\n/u).filter((paragraph) => paragraph.trim()).length, headings,
      links: linksSeen, links_returned: links.length, links_truncated: linksSeen > links.length,
      findings_returned: findings.length, findings_truncated: findingsSeen > findings.length,
      by_severity: Object.fromEntries(Object.entries(severityCounts).sort()), by_code: Object.fromEntries(Object.entries(codeCounts).sort()),
    }, findings, links, limitations, ...(comparison ? { source_comparison: comparison } : {}),
  };
}

/** @type {import('@vykor/plugins/sdk').NativeToolDefinition[]} */
export const writingTools = [
  {
    name: "KnowledgeWritingGate",
    description: "检查写作研究台账的证据分类覆盖、去重来源数量和缺失日期提示，返回 READY_TO_DRAFT 或 CONTINUE_RESEARCH。只检查输入记录，不证明来源已抓取、事实正确、独立性、时效性或语义支持。",
    inputSchema: {
      type: "object", required: ["required_families"], additionalProperties: false,
      properties: {
        required_families: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 1 } },
        min_sources: { type: "integer", minimum: 1, maximum: 20 },
        sources: { type: "array", maxItems: 100, items: {
          type: "object", additionalProperties: true,
          properties: { url: { type: "string" }, status: { type: "string" }, families: { type: "array", items: { type: "string" } }, published: { type: "string" } },
        } },
      },
    }, safeToRetry: true,
    invoke(input, context) { context.signal.throwIfAborted(); return { content: [{ type: "text", text: JSON.stringify(evaluateResearchLedger(input)) }] }; },
  },
  {
    name: "KnowledgeContentAudit",
    description: "检查稿件统计、占位、数字与引用、宣传和空泛措辞、长句、Markdown标题与链接；可与源文比较数字、引用、披露身份与新增推断。只报告词法候选问题，不核验事实或语义等价，不自动判定发布通过。",
    inputSchema: {
      type: "object", required: ["text"], additionalProperties: false,
      properties: {
        text: { type: "string", maxLength: AUDIT_MAX_BYTES },
        source_text: { type: "string", maxLength: AUDIT_MAX_BYTES },
        max_findings: { type: "integer", minimum: 1, maximum: MAX_FINDINGS, default: 100 },
      },
    }, safeToRetry: true,
    invoke(input, context) { context.signal.throwIfAborted(); return { content: [{ type: "text", text: JSON.stringify(auditContent(input)) }] }; },
  },
];
