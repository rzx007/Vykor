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
  description: "核对传入来源 ID 与原句引用，报告缺失证据、未知来源和原句不匹配。只处理输入文本，不联网、不读写文件；通过不代表事实真实或证据语义上支持结论。",
  inputSchema: {
    type: "object", required: ["sources", "claims"], additionalProperties: false,
    properties: {
      sources: { type: "array", maxItems: 24, items: {
        type: "object", required: ["id", "text"], additionalProperties: false,
        properties: {
          id: idSchema, text: { type: "string", maxLength: 24000 },
          url: { type: "string", minLength: 1, maxLength: 2000 },
          path: { type: "string", minLength: 1, maxLength: 2000 },
          title: { type: "string", maxLength: 500 },
        },
      } },
      claims: { type: "array", maxItems: 80, items: {
        type: "object", required: ["id", "text", "evidence"], additionalProperties: false,
        properties: {
          id: idSchema, text: { type: "string", minLength: 1, maxLength: 4000 },
          evidence: { type: "array", maxItems: 8, items: evidenceSchema },
        },
      } },
    },
  },
  safeToRetry: true,
  invoke(input, context) {
    context.signal.throwIfAborted();
    return { content: [{ type: "text", text: JSON.stringify(check(input)) }] };
  },
}];
