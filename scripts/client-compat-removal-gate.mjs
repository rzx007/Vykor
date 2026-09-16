import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultContractPath = resolve(scriptDir, "client-public-api-contract.json");
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function compareSemver(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function isValidDate(value) {
  if (!datePattern.test(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function evidenceIdentity(evidence) {
  return JSON.stringify({
    carrier: evidence.carrier,
    version: evidence.version,
    date: evidence.date,
    channel: evidence.channel,
    releaseNoteUrl: evidence.releaseNoteUrl ?? null,
    commit: evidence.commit ?? null,
  });
}

function validateEvidence(entry, field, defaultCarrier, addReason) {
  const evidence = entry[field];
  if (evidence === "pending") {
    addReason(entry.name, `${field} is pending`);
    return null;
  }
  if (evidence === null || evidence === undefined) {
    addReason(entry.name, `${field} is missing`);
    return null;
  }
  if (typeof evidence !== "object" || Array.isArray(evidence)) {
    addReason(entry.name, `${field} must be an evidence object`);
    return null;
  }

  for (const required of ["carrier", "version", "date", "channel"]) {
    if (typeof evidence[required] !== "string" || evidence[required].trim() === "") {
      addReason(entry.name, `${field}.${required} must be a non-empty string`);
    }
  }
  if (!evidence.releaseNoteUrl && !evidence.commit) {
    addReason(entry.name, `${field} must include releaseNoteUrl or commit`);
  }
  if (evidence.releaseNoteUrl !== undefined && !isHttpUrl(evidence.releaseNoteUrl)) {
    addReason(entry.name, `${field}.releaseNoteUrl must be an HTTP(S) URL`);
  }
  if (evidence.commit !== undefined && !/^[0-9a-f]{7,40}$/i.test(evidence.commit)) {
    addReason(entry.name, `${field}.commit must be a 7 to 40 character Git hash`);
  }
  if (evidence.carrier !== defaultCarrier) {
    addReason(entry.name, `${field} must use carrier ${defaultCarrier}`);
  }
  if (typeof evidence.version === "string" && !semverPattern.test(evidence.version)) {
    addReason(entry.name, `${field}.version must use x.y.z`);
  }
  if (typeof evidence.date === "string" && !isValidDate(evidence.date)) {
    addReason(entry.name, `${field}.date must use a real YYYY-MM-DD date`);
  }
  return evidence;
}

export function evaluateClientCompatRemovalGate(contract) {
  const entries = Array.isArray(contract?.entries) ? contract.entries : [];
  const compatibility = entries.filter(
    (entry) => entry.kind === "client-method" && entry.classification === "compatibility",
  );
  const defaultCarrier = contract?.carrier?.defaultCarrier;
  const reasons = [];
  const blockedNames = new Set();
  const addReason = (name, reason) => {
    blockedNames.add(name);
    reasons.push(`${name}: ${reason}`);
  };

  if (compatibility.length === 0) {
    reasons.push("contract contains no compatibility client methods");
  }
  if (typeof defaultCarrier !== "string" || defaultCarrier.trim() === "") {
    reasons.push("contract carrier.defaultCarrier is missing");
  }

  const sharedEvidence = new Map();
  let hasSharedEvidenceMismatch = false;
  for (const entry of compatibility) {
    if (entry.removeIn !== "stage-8-after-release-gate") {
      addReason(entry.name, "removeIn must be stage-8-after-release-gate");
    }
    const deprecated = validateEvidence(
      entry,
      "deprecatedCarrierRelease",
      defaultCarrier,
      addReason,
    );
    const retention = validateEvidence(
      entry,
      "retentionCarrierRelease",
      defaultCarrier,
      addReason,
    );

    if (deprecated && retention) {
      if (
        semverPattern.test(deprecated.version) &&
        semverPattern.test(retention.version) &&
        compareSemver(retention.version, deprecated.version) <= 0
      ) {
        addReason(entry.name, "retention release must be newer than deprecated release");
      }
      if (
        isValidDate(deprecated.date) &&
        isValidDate(retention.date) &&
        retention.date <= deprecated.date
      ) {
        addReason(entry.name, "retention release date must be after deprecated release");
      }
    }

    for (const [field, evidence] of [
      ["deprecatedCarrierRelease", deprecated],
      ["retentionCarrierRelease", retention],
    ]) {
      if (!evidence) continue;
      const identity = evidenceIdentity(evidence);
      const expected = sharedEvidence.get(field);
      if (expected === undefined) sharedEvidence.set(field, identity);
      else if (identity !== expected) {
        hasSharedEvidenceMismatch = true;
        addReason(entry.name, `${field} must describe one shared carrier release`);
      }
    }
  }

  if (hasSharedEvidenceMismatch) {
    for (const entry of compatibility) blockedNames.add(entry.name);
  }

  return {
    ready: reasons.length === 0,
    defaultCarrier: defaultCarrier ?? null,
    compatibilityEntries: compatibility.length,
    blockedEntries: blockedNames.size || (reasons.length > 0 ? compatibility.length : 0),
    reasons,
  };
}

function parseArgs(argv) {
  let contractPath = defaultContractPath;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") json = true;
    else if (arg === "--contract" && argv[index + 1]) contractPath = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { contractPath, json };
}

function main() {
  const { contractPath, json } = parseArgs(process.argv.slice(2));
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  const result = evaluateClientCompatRemovalGate(contract);

  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Client compatibility removal gate: ${result.ready ? "READY" : "BLOCKED"}`);
    console.log(`Carrier: ${result.defaultCarrier ?? "missing"}`);
    console.log(`Compatibility methods: ${result.compatibilityEntries}`);
    console.log(`Blocked methods: ${result.blockedEntries}`);
    const groups = new Map();
    for (const item of result.reasons) {
      const separator = item.indexOf(": ");
      const name = separator < 0 ? "contract" : item.slice(0, separator);
      const reason = separator < 0 ? item : item.slice(separator + 2);
      const names = groups.get(reason) ?? [];
      names.push(name);
      groups.set(reason, names);
    }
    for (const [reason, names] of groups) {
      const examples = names.slice(0, 5).join(", ");
      const remaining = names.length > 5 ? `, +${names.length - 5} more` : "";
      console.log(`- ${reason} (${names.length}): ${examples}${remaining}`);
    }
  }
  if (!result.ready) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
