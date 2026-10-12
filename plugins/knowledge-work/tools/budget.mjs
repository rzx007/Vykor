// Adapted from Orkas deep-research caps.py; see ../THIRD-PARTY-NOTICES.md.
/** @typedef {{max_subquestions:number,max_fetches:number,max_fetches_per_subquestion:number,max_model_calls:number,max_depth:number,max_cost_usd:number|null}} Caps */
/** @typedef {{fetches:number,model_calls:number,cost_usd:number}} Totals */

const DEFAULT_CAPS = {
  max_subquestions: 8, max_fetches: 40, max_fetches_per_subquestion: 8,
  max_model_calls: 30, max_depth: 2, max_cost_usd: null,
};
const ABSOLUTE_CAPS = {
  max_subquestions: 20, max_fetches: 100, max_fetches_per_subquestion: 20,
  max_model_calls: 100, max_depth: 4,
};
const STOP_WORDS = new Set("what how why who when where which is are do does did the a an of to in on for and or can you explain tell me about give".split(" "));
const CJK = /[\u3005\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7a3]+/gu;

/** @param {unknown} value @param {string} label @returns {Record<string, unknown>} */
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return /** @type {Record<string, unknown>} */ (value);
}

/** Null/missing are defaults; other invalid or nonfinite values are rejected.
 * @param {unknown} value @param {string} label @param {number} [fallback] */
function number(value, label, fallback = 0) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new TypeError(`${label} must be a finite safe number`);
  }
  return value;
}

/** @param {unknown} value @param {string} label @param {number} limit @returns {unknown[]} */
function array(value, label, limit) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > limit) throw new TypeError(`${label} must be an array within the ${limit} item limit`);
  return value;
}

/** @param {unknown} overrides @returns {Caps} */
function effectiveCaps(overrides) {
  const raw = overrides == null ? {} : object(overrides, "caps");
  const unknown = Object.keys(raw).filter(key => !Object.hasOwn(DEFAULT_CAPS, key));
  if (unknown.length) throw new TypeError(`unknown caps field(s): ${unknown.join(", ")}; allowed fields: ${Object.keys(DEFAULT_CAPS).join(", ")}`);
  /** @type {Record<string, number|null>} */
  const caps = { ...DEFAULT_CAPS };
  for (const [key, ceiling] of Object.entries(ABSOLUTE_CAPS)) {
    caps[key] = Math.max(key === "max_depth" ? 0 : 1,
      Math.min(Math.trunc(number(raw[key], `caps.${key}`, DEFAULT_CAPS[/** @type {keyof typeof ABSOLUTE_CAPS} */ (key)])), ceiling));
  }
  caps.max_cost_usd = raw.max_cost_usd == null ? null : Math.max(0, number(raw.max_cost_usd, "caps.max_cost_usd"));
  return /** @type {Caps} */ (caps);
}

/** @param {string} text */
function fold(text) { return text.normalize("NFKC").toLowerCase().replaceAll("ß", "ss").replaceAll("ς", "σ"); }

/** @param {string} text */
function tokens(text) {
  const words = [...text.matchAll(/[0-9A-Za-z][0-9A-Za-z'\-]*/gu)]
    .map(match => match[0].toLowerCase()).filter(word => word.length >= 2 && !STOP_WORDS.has(word));
  for (const match of text.matchAll(CJK)) {
    const run = [...match[0]];
    if (run.length <= 2) words.push(run.join(""));
    else for (let index = 0; index < run.length - 1; index++) words.push(run.slice(index, index + 2).join(""));
  }
  return new Set(words);
}

/** @param {Set<string>} left @param {Set<string>} right */
function similarity(left, right) {
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap++;
  return overlap / (left.size + right.size - overlap || 1);
}

/** Deduplicate and bound a proposed research plan. This does not execute or intercept any research.
 * @param {Record<string, unknown>} input */
export function planResearch(input) {
  object(input, "input");
  const caps = effectiveCaps(input.caps);
  const depth = Math.trunc(Math.max(0, number(input.depth, "depth")));
  const raw = array(input.subquestions, "subquestions", 200);
  /** @type {string[]} */ const kept = [];
  /** @type {string[]} */ const duplicates = [];
  /** @type {Set<string>[]} */ const keptTokens = [];
  const seen = new Set();
  for (const value of raw) {
    if (typeof value !== "string" || value.length > 4000) throw new TypeError("subquestion must be a string within 4000 characters");
    if (!value.trim()) continue;
    const key = fold(value).replace(/\s+/gu, " ").trim().replace(/[?!.。？！ ]+$/u, "").trim();
    const terms = tokens(value);
    if (!key || seen.has(key) || (terms.size && keptTokens.some(previous => previous.size && similarity(terms, previous) >= 0.8))) {
      duplicates.push(value);
      continue;
    }
    seen.add(key); kept.push(value.trim()); keptTokens.push(terms);
  }
  const withinQuestionCap = kept.slice(0, caps.max_subquestions);
  const subquestions = withinQuestionCap.slice(0, caps.max_fetches);
  const allowed = depth <= caps.max_depth;
  return {
    allowed, reason: allowed ? null : "max_depth_exceeded", depth, subquestions,
    fetch_budget_per_subquestion: Math.min(caps.max_fetches_per_subquestion, Math.floor(caps.max_fetches / (subquestions.length || 1))),
    total_fetch_budget: caps.max_fetches,
    dropped: {
      duplicates, over_cap: kept.slice(caps.max_subquestions),
      fetch_budget: withinQuestionCap.slice(caps.max_fetches),
    }, caps,
  };
}

/** @param {unknown} plan */
function capsFromPlan(plan) {
  const document = object(plan, "plan");
  const data = document.data === undefined ? document : object(document.data, "plan.data");
  if (!data.caps || typeof data.caps !== "object" || Array.isArray(data.caps)) throw new TypeError("plan data must contain a caps object");
  return data.caps;
}

/** Count attempts, including errors and cached fetches. Search rows are discovery, not fetches.
 * @param {unknown[]} rows */
function ledgerAttempts(rows) {
  let count = 0;
  for (const [index, value] of rows.entries()) {
    const row = object(value, `fetch ledger row ${index + 1}`);
    const kind = String(row.kind ?? "").trim().toLowerCase();
    if (["search", "query", "web_search"].includes(kind)) continue;
    if (!kind && row.query != null && row.url == null && row.canonical_url == null) continue;
    count++;
  }
  return count;
}

/** @param {number} value */
function money(value) { return Math.round(value * 1e6) / 1e6; }

/** Compute cumulative spend from supplied records. stop is advice, not a host execution block.
 * fetch_ledger is the parsed JSONL rows; plan accepts either planResearch output or {ok,data}.
 * @param {Record<string, unknown>} input */
export function accountResearch(input) {
  object(input, "input");
  if (input.plan != null && input.caps != null) throw new TypeError("caps cannot override a saved plan's caps");
  const caps = effectiveCaps(input.plan == null ? input.caps : capsFromPlan(input.plan));
  const steps = array(input.steps, "steps", 2000);
  const hasLedger = input.fetch_ledger !== undefined && input.fetch_ledger !== null;
  const ledger = hasLedger ? array(input.fetch_ledger, "fetch_ledger", 2000) : [];
  /** @type {Map<string, Totals>} */ const byStep = new Map();
  /** @type {Totals} */ const totals = { fetches: 0, model_calls: 0, cost_usd: 0 };
  /** @param {string} name @param {number} fetches @param {number} calls @param {number} cost */
  function add(name, fetches, calls, cost) {
    const current = byStep.get(name) ?? { fetches: 0, model_calls: 0, cost_usd: 0 };
    current.fetches += fetches; current.model_calls += calls; current.cost_usd = money(current.cost_usd + cost);
    totals.fetches += fetches; totals.model_calls += calls; totals.cost_usd = money(totals.cost_usd + cost);
    for (const [key, value] of Object.entries(totals)) number(value, `total ${key}`);
    byStep.set(name, current);
  }
  for (const value of steps) {
    const step = object(value, "step");
    const name = String(step.step || "?");
    if (name.length > 80) throw new TypeError("step name exceeds 80 characters");
    const fetches = Math.trunc(Math.max(0, number(step.fetches, "fetches")));
    if (hasLedger && fetches) throw new TypeError("steps.fetches cannot double count the fetch ledger");
    add(name, fetches, Math.trunc(Math.max(0, number(step.model_calls, "model_calls"))), Math.max(0, number(step.cost_usd, "cost_usd")));
  }
  if (hasLedger) add("fetch_ledger", ledgerAttempts(ledger), 0, 0);
  const limits_reached = [];
  if (totals.fetches >= caps.max_fetches) limits_reached.push("max_fetches");
  if (totals.model_calls >= caps.max_model_calls) limits_reached.push("max_model_calls");
  if (caps.max_cost_usd !== null && totals.cost_usd >= caps.max_cost_usd) limits_reached.push("max_cost_usd");
  /** @type {{fetches:number,model_calls:number,cost_usd?:number}} */
  const remaining = { fetches: Math.max(0, caps.max_fetches - totals.fetches), model_calls: Math.max(0, caps.max_model_calls - totals.model_calls) };
  if (caps.max_cost_usd !== null) remaining.cost_usd = money(Math.max(0, caps.max_cost_usd - totals.cost_usd));
  return { totals, by_step: Object.fromEntries(byStep), remaining, limits_reached, stop: limits_reached.length > 0, caps };
}

const capsSchema = {
  type: "object", additionalProperties: false,
  properties: Object.fromEntries(Object.keys(DEFAULT_CAPS).map(key => [key, {
    type: ["number", "null"], minimum: 0, maximum: 1000000,
  }])),
};
const savedPlanSchema = {
  type: "object", required: ["caps"], additionalProperties: false,
  properties: {
    caps: capsSchema, allowed: { type: "boolean" },
    reason: { type: ["string", "null"], maxLength: 80 },
    depth: { type: "number", minimum: 0, maximum: 1000000 },
    subquestions: { type: "array", maxItems: 20, items: { type: "string", maxLength: 4000 } },
    fetch_budget_per_subquestion: { type: "number", minimum: 0, maximum: 20 },
    total_fetch_budget: { type: "number", minimum: 0, maximum: 100 },
    dropped: {
      type: "object", additionalProperties: false,
      properties: {
        duplicates: { type: "array", maxItems: 200, items: { type: "string", maxLength: 4000 } },
        over_cap: { type: "array", maxItems: 200, items: { type: "string", maxLength: 4000 } },
        fetch_budget: { type: "array", maxItems: 20, items: { type: "string", maxLength: 4000 } },
      },
    },
  },
};

/** @type {import('@vykor/plugins/sdk').NativeToolDefinition[]} */
export const budgetTools = [{
  name: "KnowledgeResearchBudget",
  description: "计算研究计划及累计预算。plan 去重并裁剪子问题，account 按步骤或已读取抓取记录统计。达到上限返回 stop 建议；不拦截宿主工具，不联网、不读写文件。",
  safeToRetry: true,
  inputSchema: {
    type: "object", required: ["op"], additionalProperties: false,
    properties: {
      op: { type: "string", enum: ["plan", "account"] }, caps: capsSchema,
      depth: { type: "number", minimum: 0, maximum: 1000000 },
      subquestions: { type: "array", maxItems: 200, items: { type: "string", maxLength: 4000 } },
      steps: { type: "array", maxItems: 2000, items: {
        type: "object", additionalProperties: false,
        properties: {
          step: { type: "string", maxLength: 80 },
          fetches: { type: ["number", "null"], minimum: 0, maximum: 1000000 },
          model_calls: { type: ["number", "null"], minimum: 0, maximum: 1000000 },
          cost_usd: { type: ["number", "null"], minimum: 0, maximum: 1000000 },
        },
      } },
      fetch_ledger: { type: "array", maxItems: 2000, items: {
        type: "object", additionalProperties: false,
        properties: {
          kind: { type: "string", maxLength: 80 }, status: { type: "string", maxLength: 80 },
          url: { type: ["string", "null"], maxLength: 2000 },
          canonical_url: { type: ["string", "null"], maxLength: 2000 },
          query: { type: ["string", "null"], maxLength: 4000 },
        },
      } },
      plan: { anyOf: [savedPlanSchema, {
        type: "object", required: ["data"], additionalProperties: false,
        properties: { ok: { type: "boolean" }, data: savedPlanSchema },
      }] },
    },
  },
  invoke(input, context) {
    context.signal.throwIfAborted();
    if (input.op !== "plan" && input.op !== "account") throw new TypeError("op must be plan or account");
    const data = input.op === "plan" ? planResearch(input) : accountResearch(input);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }] };
  },
}];
