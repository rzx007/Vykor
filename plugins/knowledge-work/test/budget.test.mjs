import assert from "node:assert/strict";
import test from "node:test";
import { accountResearch, budgetTools, planResearch } from "../tools/budget.mjs";

const questions = [
  "encryption at rest guarantees", "network latency impact benchmarks",
  "offline inference accuracy tradeoffs", "battery power consumption profile",
  "user consent flow design", "data retention policy limits",
  "third party audit findings", "open source licensing terms",
  "memory footprint ceiling", "cross device state sync",
];

test("plans collapse exact/reordered/CJK duplicates while retaining different questions", () => {
  const result = planResearch({ subquestions: [
    "What is X?", "what is x", "local first ai agent privacy model",
    "privacy model local first ai agent", "中国新能源汽车的出口趋势分析",
    "分析中国新能源汽车的出口趋势", "欧洲电池回收政策的合规成本",
  ] });
  assert.deepEqual(result.subquestions, [
    "What is X?", "local first ai agent privacy model",
    "中国新能源汽车的出口趋势分析", "欧洲电池回收政策的合规成本",
  ]);
  assert.deepEqual(result.dropped.duplicates, [
    "what is x", "privacy model local first ai agent", "分析中国新能源汽车的出口趋势",
  ]);
});

test("plans trim breadth, allocate fetches, report removed questions and refuse excess depth", () => {
  const result = planResearch({ subquestions: questions, depth: 3 });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "max_depth_exceeded");
  assert.deepEqual(result.subquestions, questions.slice(0, 8));
  assert.deepEqual(result.dropped.over_cap, questions.slice(8));
  assert.equal(result.fetch_budget_per_subquestion, 5);
  assert.equal(result.total_fetch_budget, 40);
  const lower = planResearch({ subquestions: questions.slice(0, 2), caps: { max_fetches: 6 } });
  assert.equal(lower.fetch_budget_per_subquestion, 3);
  assert.equal(lower.total_fetch_budget, 6);
});

test("limits planned questions when the total fetch budget cannot cover one fetch each", () => {
  const result = planResearch({ subquestions: questions.slice(0, 4), caps: { max_fetches: 1 } });
  assert.deepEqual(result.subquestions, [questions[0]]);
  assert.deepEqual(result.dropped.fetch_budget, questions.slice(1, 4));
  assert.equal(result.fetch_budget_per_subquestion, 1);
  assert.equal(result.total_fetch_budget, 1);
});

test("budget overrides can lower limits but cannot exceed absolute ceilings", () => {
  const result = planResearch({ subquestions: questions, caps: {
    max_subquestions: 500, max_fetches: 10000, max_fetches_per_subquestion: 100,
    max_model_calls: 10000, max_depth: 100,
  } });
  assert.deepEqual(result.caps, {
    max_subquestions: 20, max_fetches: 100, max_fetches_per_subquestion: 20,
    max_model_calls: 100, max_depth: 4, max_cost_usd: null,
  });
  assert.equal(planResearch({ caps: { max_fetches: 0, max_depth: -1 } }).caps.max_fetches, 1);
  assert.throws(() => planResearch({ caps: { unknown_limit: 1 } }), /unknown caps field/i);
});

test("account aggregates repeated steps, bounded money precision and safe unusual step names", () => {
  const result = accountResearch({ steps: [
    { step: "gather", fetches: 3, model_calls: 1, cost_usd: 0.01 },
    { step: "gather", fetches: 2, model_calls: 1, cost_usd: 0.02 },
    { step: "__proto__", model_calls: 2, cost_usd: 0.05 },
  ] });
  assert.deepEqual(result.totals, { fetches: 5, model_calls: 4, cost_usd: 0.08 });
  assert.equal(result.by_step.gather.fetches, 5);
  assert.equal(Object.hasOwn(result.by_step, "__proto__"), true);
  assert.equal(result.by_step.__proto__.model_calls, 2);
  assert.equal(result.stop, false);
});

test("account distinguishes remaining, exhausted and overspent budgets without hiding the overrun", () => {
  for (const [fetches, stop, remaining] of [[39, false, 1], [40, true, 0], [41, true, 0]]) {
    const result = accountResearch({ steps: [{ step: "gather", fetches }] });
    assert.equal(result.stop, stop);
    assert.equal(result.remaining.fetches, remaining);
    assert.equal(result.totals.fetches, fetches);
    assert.deepEqual(result.limits_reached, stop ? ["max_fetches"] : []);
  }
  const result = accountResearch({ caps: { max_model_calls: 2, max_cost_usd: 0.1 }, steps: [
    { step: "write", model_calls: 2, cost_usd: 0.11 },
  ] });
  assert.deepEqual(result.limits_reached, ["max_model_calls", "max_cost_usd"]);
  assert.equal(result.remaining.cost_usd, 0);
  assert.equal(accountResearch({ steps: [{ cost_usd: 0.5 }] }).stop, false);
});

test("ledger accounting counts failed/cached attempts and repeated URLs but excludes discovery", () => {
  const plan = { ok: true, data: planResearch({ caps: { max_fetches: 3 } }) };
  const result = accountResearch({ plan, fetch_ledger: [
    { kind: "search", query: "official privacy", status: "ok" },
    { kind: "WEB_SEARCH", query: "official pricing", status: "failed" },
    { query: "legacy discovery" },
    { kind: "fetch", url: "https://example.org/a", status: "ok" },
    { url: "https://example.org/a", status: "failed" },
    { canonical_url: "https://example.org/a", status: "cached" },
  ], steps: [{ step: "analysis", model_calls: 2, cost_usd: 0.02 }] });
  assert.deepEqual(result.totals, { fetches: 3, model_calls: 2, cost_usd: 0.02 });
  assert.equal(result.by_step.fetch_ledger.fetches, 3);
  assert.equal(result.stop, true);
  assert.equal(result.caps.max_fetches, 3);
});

test("ledger mode rejects missing plan caps, malformed rows and duplicate fetch accounting", () => {
  assert.throws(() => accountResearch({ plan: { data: {} }, fetch_ledger: [] }), /caps/i);
  assert.throws(() => accountResearch({ fetch_ledger: [null] }), /ledger.*row/i);
  assert.throws(() => accountResearch({ fetch_ledger: [{}], steps: [{ fetches: 1 }] }), /fetches.*ledger|ledger.*fetches/i);
  assert.throws(() => accountResearch({ plan: planResearch({}), caps: { max_fetches: 80 } }), /plan.*caps|caps.*plan/i);
});

test("nonfinite inputs and oversized collections cannot corrupt budget arithmetic", () => {
  for (const value of [NaN, Infinity, -Infinity, "not a number"]) {
    assert.throws(() => planResearch({ caps: { max_fetches: value } }), /finite|number/i);
    assert.throws(() => accountResearch({ steps: [{ fetches: value }] }), /finite|number/i);
  }
  assert.equal(accountResearch({ steps: [{ fetches: -2, model_calls: null }] }).totals.fetches, 0);
  assert.throws(() => accountResearch({ steps: Array(2001).fill({}) }), /steps.*limit|steps.*2000/i);
});

test("the native budget tool exposes results and honours cancellation before calculation", () => {
  const [tool] = budgetTools;
  assert.equal(tool.name, "KnowledgeResearchBudget");
  const signal = new AbortController().signal;
  const result = tool.invoke({ op: "account", steps: [{ fetches: 40 }] }, { signal });
  assert.equal(JSON.parse(result.content[0].text).data.stop, true);
  assert.throws(() => tool.invoke({ op: "unknown" }, { signal }), /op/i);
  const controller = new AbortController(); controller.abort();
  assert.throws(() => tool.invoke({ op: "plan" }, { signal: controller.signal }), /abort/i);
});
