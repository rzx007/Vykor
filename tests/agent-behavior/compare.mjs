import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const conditions = ["mode", "model", "provider", "fixtureVersion", "fixtureSha256", "parameters", "permission", "cases"];
const outcomes = ["failed", "pending_review", "passed"];

function readReport(path) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  for (const field of conditions) {
    if (field === "provider" && report?.mode === "scripted") continue;
    if (report?.[field] == null) throw new Error(`Missing ${field} in ${path}`);
  }
  return report;
}

function samples(report, label) {
  const repeats = report.parameters.repeats;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3 || !report.cases?.length || !Array.isArray(report.results)) {
    throw new Error(`${label} report is missing its cases, repeats, or results`);
  }
  const required = new Set();
  for (const { id } of report.cases) {
    if (typeof id !== "string" || !id || required.has(`${id}#1`)) throw new Error(`${label} report has an invalid or duplicate case`);
    for (let repeat = 1; repeat <= repeats; repeat++) required.add(`${id}#${repeat}`);
  }
  const indexed = new Map();
  for (const { caseId, repeat, status } of report.results) {
    const key = `${caseId}#${repeat}`;
    if (indexed.has(key)) throw new Error(`Duplicate ${label} sample: ${key}`);
    if (!required.delete(key)) throw new Error(`Unexpected ${label} sample: ${key}`);
    if (!outcomes.includes(status)) throw new Error(`Incomplete ${label} sample: ${key} (${status})`);
    indexed.set(key, status);
  }
  if (required.size > 0) throw new Error(`Missing ${label} samples: ${[...required].join(", ")}`);
  return indexed;
}

function counts(indexed) {
  const summary = { passed: 0, pending_review: 0, failed: 0 };
  for (const status of indexed.values()) summary[status]++;
  return summary;
}

function compare(baseline, candidate) {
  for (const field of conditions) {
    if (!isDeepStrictEqual(baseline[field], candidate[field])) throw new Error(`Incompatible evaluation reports: ${field}`);
  }
  const before = samples(baseline, "baseline");
  const after = samples(candidate, "candidate");
  const regressions = [], improvements = [], knownFailures = [];
  for (const [key, previous] of before) {
    const current = after.get(key);
    if (previous === current) {
      if (current === "failed") knownFailures.push(key);
    } else {
      const change = `${key}: ${previous} -> ${current}`;
      (outcomes.indexOf(current) < outcomes.indexOf(previous) ? regressions : improvements).push(change);
    }
  }
  return { baseline: counts(before), candidate: counts(after), regressions, improvements, knownFailures };
}

try {
  const [first, second, extra] = process.argv.slice(2);
  if (!first || !second || extra) throw new Error("Usage: node compare.mjs <baseline.json> <candidate.json> or --snapshot <report.json>");
  const report = readReport(second);
  if (first === "--snapshot") {
    samples(report, "source");
    const snapshot = Object.fromEntries([...conditions, "revision", "workingTreeDirty"].map(field => [field, report[field]]));
    snapshot.results = report.results.map(({ caseId, repeat, status }) => ({ caseId, repeat, status }));
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    const result = compare(readReport(first), report);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.regressions.length > 0 ? 1 : 0;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
