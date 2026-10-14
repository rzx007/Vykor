import { budgetTools } from "./budget.mjs";
import { compressionTools } from "./compress.mjs";
import { writingTools } from "./writing.mjs";
import { verifyResearch, renderResearchReport, normalizeCitationUrl } from "./citations.mjs";
import { readResearchSources } from "./source-records.mjs";
/** @typedef {{id:string, text:string, url?:string, path?:string, title?:string}} Source */
/** @typedef {{sourceId:string, quote:string}} Evidence */
/** @typedef {{id:string, text:string, evidence:Evidence[]}} Claim */
/** @typedef {{claimId:string, sourceId?:string, code:'missing_evidence'|'unknown_source'|'quote_not_found'}} Finding */

const idSchema = { type: "string", minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" };
const evidenceSchema = {
  type: "object", required: ["sourceId", "quote"], additionalProperties: false,
  properties: { sourceId: idSchema, quote: { type: "string", minLength: 1, maxLength: 4000 } },
};

/** Normalize layout whitespace only; retain case, punctuation and negation. @param {string} text */
function normalized(text) { return text.replace(/\s+/gu, " ").trim(); }

/** @param {Record<string, unknown>} input */
function check(input) {
  // Host schema bounds every collection/string. Repeat shape guards for direct callers.
  if (!Array.isArray(input.sources) || !Array.isArray(input.claims)) throw new TypeError("sources and claims must be arrays");
  if (input.sources.some(source => source?.text?.length > 24000)) throw Object.assign(new TypeError("Legacy source text exceeds 24000 characters"), { code: "tool_input_invalid" });
  /** @type {Map<string,string>} */
  const sources = new Map();
  for (const raw of input.sources) {
    const source = /** @type {Source} */ (raw);
    if (!source || typeof source.id !== "string" || typeof source.text !== "string") throw new TypeError("Invalid source");
    if (sources.has(source.id)) throw new TypeError(`Duplicate source ID: ${source.id}`);
    const hasUrl = typeof source.url === "string" && source.url.trim().length > 0;
    const hasPath = typeof source.path === "string" && source.path.trim().length > 0;
    if (hasUrl === hasPath) throw new TypeError("Each source needs exactly one url or path");
    if (hasUrl) {
      const url = new URL(source.url ?? "");
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new TypeError("Source URL must be HTTP(S) without credentials");
    }
    // Paths and URLs are references only: this tool never reads or fetches them.
    sources.set(source.id, normalized(source.text));
  }
  const claimIds = new Set();
  /** @type {Finding[]} */
  const findings = [];
  for (const raw of input.claims) {
    const claim = /** @type {Claim} */ (raw);
    if (!claim || typeof claim.id !== "string" || typeof claim.text !== "string" || !Array.isArray(claim.evidence)) throw new TypeError("Invalid claim");
    if (claimIds.has(claim.id)) throw new TypeError(`Duplicate claim ID: ${claim.id}`);
    claimIds.add(claim.id);
    if (!claim.evidence.length) findings.push({ claimId: claim.id, code: "missing_evidence" });
    for (const evidence of claim.evidence) {
      if (!evidence || typeof evidence.sourceId !== "string" || typeof evidence.quote !== "string" || !normalized(evidence.quote)) throw new TypeError("Evidence quote must not be blank");
      const text = sources.get(evidence.sourceId);
      if (text === undefined) findings.push({ claimId: claim.id, sourceId: evidence.sourceId, code: "unknown_source" });
      else if (!text.includes(normalized(evidence.quote))) findings.push({ claimId: claim.id, sourceId: evidence.sourceId, code: "quote_not_found" });
    }
  }
  return {
    attributionPassed: findings.length === 0,
    semanticVerification: "not_performed",
    checkedSources: sources.size,
    checkedClaims: claimIds.size,
    findings,
  };
}

/** @type {import('@vykor/plugins/sdk').NativeToolRegister} */
export const registerTools = () => [{
  name: "KnowledgeResearchCheck",
  description: "核对来源、原句和DOI归属。source_ref读取保存原文，返回实际来源长度及截断信息；report仅在引用检查通过时组装分析，否则返回report_ready=false与缺口报告，不判事实真伪或语义支持。",
  inputSchema: {
    type: "object", required: ["sources", "claims"], additionalProperties: false,
    properties: {
      op: { type: "string", enum: ["verify", "references", "report"] },
      recorded_only: { type: "boolean" },
      title: { type: "string", maxLength: 500 }, analysis_markdown: { type: "string", maxLength: 50000 },
      comparison: { type: "array", maxItems: 50, items: { type: "object", properties: {
        candidate: { type: "string", maxLength: 2000 }, evidence_sources: { type: "array", maxItems: 24, items: { type: "string", maxLength: 2000 } },
        field_claims: { type: "object" },
      } } },
      sources: { type: "array", maxItems: 24, items: {
        type: "object", required: ["id", "text"], additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: 2000 }, text: { type: "string", maxLength: 100000 },
          url: { type: "string", minLength: 1, maxLength: 2000 },
          path: { type: "string", minLength: 1, maxLength: 2000 },
          title: { type: "string", maxLength: 60000 }, source_ref: { type: "string", minLength: 36, maxLength: 36 },
          origin: { type: "string", maxLength: 40 },
          authors: { type: "array", maxItems: 10, items: { type: "string", maxLength: 2000 } },
          doi: { type: ["string", "null"], maxLength: 2000 }, date: { type: ["string", "null"], maxLength: 100 },
          accessed_at: { type: "string", maxLength: 100 }, access_date: { type: "string", maxLength: 100 },
          published_at: { type: ["string", "null"], maxLength: 100 }, publisher: { type: ["string", "null"], maxLength: 2000 },
          venue: { type: ["string", "null"], maxLength: 2000 }, pmid: { type: ["string", "null"], maxLength: 100 },
          source_type: { type: "string", maxLength: 100 }, source: { type: "string", maxLength: 100 },
          limitation: { type: "string", maxLength: 4000 }, limitations: { type: "string", maxLength: 4000 },
          text_truncated: { type: "boolean" },
          stored_chars: { type: "integer" }, returned_chars: { type: "integer" }, returned_offset: { type: "integer" },
          source_text_truncated: { type: ["boolean", "null"] }, read_truncated: { type: "boolean" }, next_offset: { type: ["integer", "null"] },
        },
      } },
      claims: { type: "array", maxItems: 80, items: {
        type: "object", required: ["id", "text"], additionalProperties: false,
        properties: {
          id: idSchema, text: { type: "string", minLength: 1, maxLength: 4000 },
          evidence: { type: "array", maxItems: 8, items: evidenceSchema },
          citations: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false, properties: {
            source: { type: "string", maxLength: 2000 }, url: { type: "string", maxLength: 2000 },
            quote: { type: "string", maxLength: 4000 }, doi: { type: "string", maxLength: 2000 }, limitation: { type: "string", maxLength: 4000 },
          } } }, limitation: { type: "string", maxLength: 4000 },
        },
      } },
    },
  },
  safeToRetry: true,
  async invoke(input, context) {
    context.signal.throwIfAborted();
    if (!input.op) return { content: [{ type: "text", text: JSON.stringify(check(input)) }] };
    const supplied = /** @type {Array<Record<string, any>>} */ (input.sources);
    const refs = supplied.map(source => source.source_ref).filter(Boolean);
    const records = refs.length ? await readResearchSources({ source_refs: refs }, context, true) : {
      sources: /** @type {Array<Record<string,any>>} */ ([]), issues: /** @type {Array<Record<string,any>>} */ ([]),
    };
    const byRef = new Map(records.sources.map(source => [source.source_ref, source]));
    const sources = supplied.map(source => {
      const record = byRef.get(source.source_ref);
      if (!source.source_ref) return source;
      if (!record || (source.url && normalizeCitationUrl(source.url) !== normalizeCitationUrl(record.url))) {
        if (record) records.issues.push({ source_ref: source.source_ref, code: "source_record_url_mismatch" });
        return { ...source, invalid_source_ref: true };
      }
      // Caller aliases/limitations are allowed; source DOI and dates must come from saved retrieval metadata.
      return { ...source, ...record, id: source.id, title: record.title ?? record.url,
        doi: record.doi ?? null, date: record.date ?? null, published_at: record.published_at ?? null,
        authors: record.authors ?? [], publisher: record.publisher ?? null, venue: record.venue ?? null, pmid: record.pmid ?? null };
    });
    const result = verifyResearch({ ...input, sources });
    result.source_record_issues = records.issues;
    result.source_diagnostics = sources.map(source => ({ id: source.id, source_ref: source.source_ref,
      provenance: source.plugin_recorded ? "plugin_recorded" : "input_only",
      checked_chars: source.text.length, stored_chars: source.stored_chars ?? null,
      source_text_truncated: source.source_text_truncated ?? null, read_truncated: source.read_truncated ?? null,
    }));
    if (records.issues.length) result.attributionPassed = false;
    if (input.op === "report") {
      result.report_ready = result.attributionPassed === true && !result.abstain;
      result.report_markdown = renderResearchReport(result, input);
      if (!result.report_ready) return { isError: true, failureKind: "precondition", executionState: "completed",
        content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    const output = input.op === "references" ? { abstain: result.abstain, references: result.references, semanticVerification: result.semanticVerification } : result;
    return { content: [{ type: "text", text: JSON.stringify(output) }] };
  },
}, ...budgetTools, ...compressionTools, ...writingTools];
