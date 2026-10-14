/** Citation attribution and report assembly adapted from Orkas citations.py. No semantic judgement. */
/** @typedef {Record<string, any>} Row */
/** @type {Array<[string,string]>} */
const columns = [
  ["candidate", "Candidate"], ["best_for", "Best for"], ["os", "OS"], ["setup_ease", "Setup/ease"],
  ["model_capabilities", "Model capabilities"], ["local_offline", "Local/offline"],
  ["privacy_data_handling", "Privacy/data handling"], ["pricing_cost", "Pricing/cost"],
  ["key_limitations", "Key limitations"], ["ideal_user", "Ideal user"], ["evidence", "Evidence"],
];
const inferenceFields = new Set(["best_for", "ideal_user"]);
const doiPattern = /^10\.\d{4,9}\/[-._;()/:a-z0-9]+$/i;
/** @param {unknown} value */
const inline = value => String(value ?? "").replace(/\s+/gu, " ").trim();
/** @param {unknown} value */
export function normalizeCitationText(value) {
  return inline(String(value ?? "").normalize("NFKC").replace(/[‘’‚‛]/gu, "'")
    .replace(/[“”„‟]/gu, '"').replace(/[–—―−]/gu, "-").replace(/…/gu, "..."))
    .toLowerCase().replace(/ß/gu, "ss").replace(/ς/gu, "σ");
}
/** @param {unknown} value */
export function normalizeCitationUrl(value) {
  const raw = inline(value);
  if (!raw) return "";
  const url = new URL(raw);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new TypeError("Source URL must be HTTP(S) without credentials");
  url.hash = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/$/u, "");
  return url.toString();
}
/** @param {unknown} value */
const ids = value => Array.isArray(value) ? value.map(inline).filter(Boolean) : typeof value === "string" && value.trim() ? [value.trim()] : [];
/** @param {unknown} value */
const cell = value => inline(value).replace(/\|/gu, "\\|").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
/** @param {unknown} value */
const safeLabel = value => cell(value).replace(/[\[\]]/gu, "");

/** @param {Row} payload @returns {Row} */
export function verifyResearch(payload) {
  const sources = payload.sources ?? [];
  const claims = payload.claims ?? [];
  if (!Array.isArray(sources) || sources.length > 200 || !Array.isArray(claims) || claims.length > 200) throw new TypeError("Invalid or oversized sources/claims");
  /** @type {Map<string, Row>} */
  const byId = new Map();
  /** @type {Map<string, Row>} */
  const byUrl = new Map();
  /** @type {Row[]} */
  const warnings = [];
  for (const source of sources) {
    if (!source || typeof source.id !== "string" || typeof source.text !== "string" || source.text.length > 100_000) throw new TypeError("Invalid source");
    if (byId.has(source.id)) throw new TypeError(`Duplicate source ID: ${source.id}`);
    byId.set(source.id, source);
    if (source.url) {
      const key = normalizeCitationUrl(source.url);
      if (!byUrl.has(key)) byUrl.set(key, source);
    } else if (!source.path) throw new TypeError("Each source needs url or path");
  }
  const claimIds = new Set();
  /** @type {Row[]} */
  const evidenceRows = [], flags = [], outClaims = [], refs = [];
  const refNumbers = new Map();
  let verified = 0, weak = 0, flagged = 0, total = 0;
  for (const [index, claim] of claims.entries()) {
    if (!claim || typeof claim.text !== "string") throw new TypeError("Invalid claim");
    const claimId = inline(claim.id) || `claim_${index + 1}`;
    if (claimIds.has(claimId)) throw new TypeError(`Duplicate claim ID: ${claimId}`);
    claimIds.add(claimId);
    const citations = claim.citations ?? (claim.evidence ?? []).map((/** @type {Row} */ e) => ({ source: e.sourceId, quote: e.quote, doi: e.doi }));
    if (!Array.isArray(citations) || citations.length > 8) throw new TypeError("Invalid citations");
    if (!citations.length) warnings.push({ claim: index, issue: "claim_evidence_missing" });
    /** @type {Row[]} */
    const classified = [];
    for (const [citationIndex, citation] of citations.entries()) {
      if (!citation || typeof citation !== "object") throw new TypeError("Invalid citation");
      total++;
      const source = byId.get(inline(citation.source)) ?? (citation.url ? byUrl.get(normalizeCitationUrl(citation.url)) : undefined);
      const bindingMismatch = Boolean(source && citation.url && (!source.url || normalizeCitationUrl(citation.url) !== normalizeCitationUrl(source.url)));
      const provenanceAvailable = Boolean(source && !bindingMismatch && !source.invalid_source_ref && (!payload.recorded_only || source.plugin_recorded));
      const normalizedQuote = normalizeCitationText(citation.quote);
      const normalizedText = normalizeCitationText(source?.text);
      const quoteStatus = !provenanceAvailable ? "unverifiable" : !normalizedQuote ? "absent" : [...normalizedQuote].length < 12 ? "too_short" : normalizedText.includes(normalizedQuote) ? "verified" : "not_found";
      const doi = inline(citation.doi).toLowerCase();
      const sourceDoi = inline(source?.doi).replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "").toLowerCase();
      const doiStatus = !provenanceAvailable ? "unverifiable" : !doi ? "absent" : !doiPattern.test(doi) ? "malformed" : sourceDoi === doi ? "verified" : "unverified";
      const verdict = !provenanceAvailable || quoteStatus === "not_found" || ["malformed", "unverified"].includes(doiStatus) ? "flagged" : quoteStatus === "verified" ? "verified" : "weak";
      /** @type {Row} */
      const info = { source: citation.source, url: citation.url, resolved_by: source ? byId.has(inline(citation.source)) ? "id" : "url" : "unknown",
        url_status: provenanceAvailable ? "known" : "unknown", quote_status: quoteStatus, doi_status: doiStatus, verdict,
        provenance: source?.plugin_recorded ? "plugin_recorded" : "input_only",
        source_text_truncated: source?.source_text_truncated ?? (typeof source?.text_truncated === "boolean" ? source.text_truncated : null) };
      if (verdict === "verified") verified++;
      else if (verdict === "weak") weak++;
      else {
        flagged++;
        flags.push({ claim: index, citation: citationIndex, issue: bindingMismatch ? "citation_source_url_mismatch" : !provenanceAvailable ? "citation_source_not_found" : quoteStatus === "not_found" ? "quote_not_found_in_source" : doiStatus === "malformed" ? "doi_malformed" : "doi_not_found_in_source" });
      }
      if (source && verdict !== "flagged") {
        const key = source.url ? normalizeCitationUrl(source.url) : `path:${source.path}`;
        let ref = refNumbers.get(key);
        if (!ref) {
          ref = refs.length + 1; refNumbers.set(key, ref);
          refs.push({ ref, title: source.title, url: source.url, path: source.path, date: source.date ?? source.published_at,
            authors: source.authors ?? [], publisher: source.publisher ?? source.venue, doi: source.doi, pmid: source.pmid,
            source_type: source.source_type ?? source.source, source_ref: source.source_ref });
        }
        info.ref = ref;
        if (verdict === "verified") evidenceRows.push({ evidence_id: payload.compact_landscape ? claimId : `E${total}`, claim_id: claimId, ref,
          source_id: source.id, title: source.title, claim: claim.text, quote: citation.quote, url: source.url, path: source.path,
          source_date: source.date ?? source.published_at, accessed_at: source.accessed_at ?? source.access_date,
          limitation: citation.limitation ?? claim.limitation ?? source.limitation ?? source.limitations,
          source_ref: source.source_ref, provenance: info.provenance, quote_status: "verified" });
      }
      classified.push(info);
    }
    outClaims.push({ id: claimId, text: claim.text, citations: classified });
  }
  const comparison = renderComparison(payload.comparison, evidenceRows);
  const abstain = sources.length === 0 || (payload.recorded_only && !sources.some((/** @type {Row} */ s) => s.plugin_recorded));
  return { abstain, abstain_reason: abstain ? "no_usable_sources" : null,
    attributionPassed: !abstain && total > 0 && flagged === 0 && weak === 0 && warnings.length === 0 && !comparison.warnings.some((/** @type {Row} */ w) => w.issue === "comparison_field_evidence_missing"),
    semanticVerification: "not_performed", summary: { claims: outClaims.length, citations: total, verified, weak, flagged, comparison_rows: comparison.rows.length },
    claims: outClaims, references: refs, evidence_rows: evidenceRows, evidence_markdown: renderEvidence(evidenceRows),
    comparison_rows: comparison.rows, comparison_markdown: comparison.markdown, comparison_coverage: comparison.coverage,
    comparison_warnings: comparison.warnings, flags, warnings };
}
/** @param {unknown} input @param {Row[]} evidenceRows */
function renderComparison(input, evidenceRows) {
  if (input !== undefined && (!Array.isArray(input) || input.length > 50)) throw new TypeError("Invalid comparison");
  /** @type {Row[]} */
  const rows = [], warnings = [], coverage = [];
  for (const [index, candidate] of (Array.isArray(input) ? input : []).entries()) {
    if (!candidate || typeof candidate !== "object") throw new TypeError("Invalid comparison row");
    /** @type {Row} */
    const row = { candidate: inline(candidate.candidate) || `Unnamed candidate ${index + 1}` };
    const sourceIds = new Set(ids(candidate.evidence_sources));
    const evidenceIds = new Set();
    for (const [key, label] of columns.slice(1, -1)) {
      const value = inline(candidate[key]);
      if (!value || /^Not verified\b/iu.test(value) || inferenceFields.has(key)) {
        row[key] = value || `Not verified: ${label}`;
        if (!value) warnings.push({ row: index, field: key, issue: "comparison_field_missing" });
        continue;
      }
      const claimIds = new Set(ids(candidate.field_claims?.[key]));
      const matched = evidenceRows.filter(e => claimIds.has(e.claim_id) && sourceIds.has(e.source_id));
      const boundIds = [...new Set(matched.map(e => e.evidence_id))];
      if (!boundIds.length) {
        row[key] = `Not verified: ${label}`;
        warnings.push({ row: index, candidate: row.candidate, field: key, issue: "comparison_field_evidence_missing" });
      } else {
        row[key] = `${value} [${boundIds.join(", ")}]`;
        boundIds.forEach(id => evidenceIds.add(id));
      }
    }
    row.evidence = evidenceIds.size ? [...evidenceIds].join(", ") : "Not verified: no verified Evidence ID";
    rows.push(row);
    coverage.push({ candidate: row.candidate, missing_fields: columns.slice(1, -1).filter(([key]) => /^Not verified/iu.test(row[key])).map(([key]) => key) });
  }
  const markdown = rows.length ? [
    `| ${columns.map(([, label]) => label).join(" | ")} |`, `|${columns.map(() => "---").join("|")}|`,
    ...rows.map(row => `| ${columns.map(([key]) => cell(row[key])).join(" | ")} |`),
  ].join("\n") : "";
  return { rows, warnings, coverage, markdown };
}
/** @param {Row[]} rows */
function renderEvidence(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = row.url || row.path || row.source_id;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const lines = [];
  for (const list of grouped.values()) {
    const first = list[0];
    const target = first.url || first.path;
    lines.push(`- [${first.ref}] ${target ? `[${safeLabel(first.title || target)}](<${target}>)` : safeLabel(first.title)}`);
    if (first.source_date) lines.push(`  - Published: ${cell(first.source_date)}`);
    if (first.accessed_at) lines.push(`  - Accessed: ${cell(first.accessed_at)}`);
    for (const row of list) {
      lines.push(`  - [${cell(row.evidence_id)}] ${cell(row.claim)} — "${cell(row.quote)}" — quote matched (${cell(row.provenance)})`);
      if (row.limitation) lines.push(`    - Limitation: ${cell(row.limitation)}`);
    }
  }
  return lines.join("\n");
}
/** @param {Row} result @param {Row} options */
export function renderResearchReport(result, options = {}) {
  const ready = !result.abstain && result.attributionPassed === true;
  const lines = [`# ${inline(options.title || "Research report")}`, "",
    ...(ready ? [String(options.analysis_markdown ?? options.analysis ?? "").trim(), ""]
      : ["## 尚未完成引用检查", "", "本次输入未通过引用检查，分析正文未组装为报告。以下仅保留已匹配的证据与检查缺口；不能据此宣称原报告或结论已核验。", ""]),
    "Citation attribution is checked separately from semantic support; conclusions still require context review."];
  if (result.abstain) lines.push("", "No usable source-backed conclusions are available.");
  if (ready && result.comparison_markdown) lines.push("", "## Comparison", "", result.comparison_markdown);
  lines.push("", "## Evidence used", "", result.evidence_markdown || "No verified evidence.");
  const gaps = [...result.flags, ...result.warnings, ...result.comparison_warnings, ...(result.source_record_issues ?? [])];
  if (gaps.length) lines.push("", "## Verification gaps", "",
    ...gaps.map((/** @type {Row} */ issue) => `- ${cell(issue.issue ?? issue.code)}${issue.field ? ` (${cell(issue.field)})` : ""}`));
  return `${lines.join("\n")}\n`;
}
