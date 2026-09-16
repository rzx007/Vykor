import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildReleaseEvidence,
  renderReleaseNotes,
  validateReleasePhase,
} from "./client-compat-release.mjs";

const ledger = JSON.parse(readFileSync(new URL("./client-compat-removal-ledger.json", import.meta.url)));

function release(version, tag = `v${version}`) {
  return {
    version,
    tag,
    commit: "a".repeat(40),
    publishedAt: "2026-09-16T08:00:00.000Z",
    workflowRunUrl: "https://github.com/rzx007/openharness-ts/actions/runs/123",
    releaseNoteUrl: `https://github.com/rzx007/openharness-ts/releases/tag/${tag}`,
    npm: { package: "@rzx/ohs", version },
  };
}

test("regular release is accepted without mutating the ledger", () => {
  const before = structuredClone(ledger);
  assert.deepEqual(validateReleasePhase({ phase: "regular", version: "1.2.3", ledger }), {
    phase: "regular",
    version: "1.2.3",
    methodCount: 118,
  });
  assert.deepEqual(ledger, before);
});

test("deprecation release requires the untouched pending lifecycle", () => {
  assert.equal(validateReleasePhase({
    phase: "client-deprecation",
    version: "1.2.3",
    ledger,
  }).phase, "client-deprecation");

  const alreadyPublished = structuredClone(ledger);
  alreadyPublished.releases.deprecation = release("1.2.3");
  assert.throws(
    () => validateReleasePhase({ phase: "client-deprecation", version: "1.2.4", ledger: alreadyPublished }),
    /deprecation release must still be pending/,
  );
});

test("retention release requires A evidence and a newer stable version", () => {
  const withA = structuredClone(ledger);
  withA.releases.deprecation = release("1.2.3");
  assert.equal(validateReleasePhase({
    phase: "client-retention",
    version: "1.2.4",
    ledger: withA,
  }).phase, "client-retention");
  assert.throws(
    () => validateReleasePhase({ phase: "client-retention", version: "1.2.3", ledger: withA }),
    /newer than deprecation release/,
  );
  assert.throws(
    () => validateReleasePhase({ phase: "client-retention", version: "1.2.4", ledger }),
    /requires recorded deprecation evidence/,
  );
});

test("breaking removal release requires consumed authorization and exact next-major target", () => {
  const ready = structuredClone(ledger);
  ready.authorization = {
    status: "ready",
    targetVersion: "2.0.0",
    authorizedAt: "2026-09-16T09:00:00.000Z",
    baselineSha256: ready.baseline.methodsSha256,
    evidenceSha256: "b".repeat(64),
  };
  assert.throws(
    () => validateReleasePhase({ phase: "client-breaking-removal", version: "2.0.1", ledger: ready }),
    /requires consumed authorization/,
  );
  assert.throws(
    () => validateReleasePhase({ phase: "client-breaking-removal", version: "2.0.0", ledger }),
    /requires consumed authorization/,
  );

  const consumed = structuredClone(ready);
  consumed.authorization.status = "consumed";
  consumed.removal = { status: "removed", commit: "c".repeat(40) };
  assert.equal(validateReleasePhase({
    phase: "client-breaking-removal",
    version: "2.0.0",
    ledger: consumed,
  }).phase, "client-breaking-removal");
  assert.throws(
    () => validateReleasePhase({ phase: "client-breaking-removal", version: "2.0.1", ledger: consumed }),
    /must equal authorized targetVersion/,
  );
});

test("release notes carry the required A, B, and C messages", () => {
  const a = renderReleaseNotes({ phase: "client-deprecation", version: "1.2.3", ledger });
  assert.match(a, /118 compatibility methods are deprecated/i);
  assert.match(a, /docs\/client-public-api-migration\.md/);
  assert.match(a, /earliest removal.*next major/i);

  const withA = structuredClone(ledger);
  withA.releases.deprecation = release("1.2.3");
  const b = renderReleaseNotes({ phase: "client-retention", version: "1.2.4", ledger: withA });
  assert.match(b, /still retains all 118 compatibility methods/i);
  assert.match(b, /next major/i);

  const consumed = structuredClone(ledger);
  consumed.authorization.status = "consumed";
  consumed.authorization.targetVersion = "2.0.0";
  consumed.removal = { status: "removed", commit: "c".repeat(40) };
  const c = renderReleaseNotes({ phase: "client-breaking-removal", version: "2.0.0", ledger: consumed });
  assert.match(c, /breaking change/i);
  assert.match(c, /\| `health` \| `protocol\.health` \|/);
  assert.match(c, /npm install -g @rzx\/ohs@2\.0\.0/);
});

test("final evidence has the gate shape and rejects mismatched npm identity", () => {
  for (const phase of ["client-deprecation", "client-retention", "client-breaking-removal"]) {
    const result = buildReleaseEvidence({
      phase,
      ...release("1.2.3"),
      npmVerified: true,
      releaseNotesSha256: "c".repeat(64),
    });
    assert.equal(result.phase, phase);
    assert.equal(result.channel, "stable");
    assert.equal(result.npm.verified, true);
    assert.equal(result.checks.releaseNotes, "verified");
  }

  assert.throws(
    () => buildReleaseEvidence({
      phase: "client-deprecation",
      ...release("1.2.3"),
      npm: { package: "wrong", version: "1.2.3" },
      npmVerified: true,
      releaseNotesSha256: "c".repeat(64),
    }),
    /npm package must be @rzx\/ohs/,
  );
});

test("workflow delays tag creation, orders publication, and uploads evidence", () => {
  const workflow = readFileSync(new URL("../.github/workflows/tag-release.yml", import.meta.url), "utf8");
  for (const phase of ["regular", "client-deprecation", "client-retention", "client-breaking-removal"]) {
    assert.match(workflow, new RegExp(`- ${phase}`));
  }
  const validateJob = workflow.slice(workflow.indexOf("  validate:"), workflow.indexOf("  preflight:"));
  assert.doesNotMatch(validateJob, /git push/);
  assert.match(workflow, /build-desktop:\s*\n\s+needs: \[validate, preflight\]/);
  assert.match(workflow, /create-tag:[\s\S]*needs: \[validate, preflight, build-desktop\][\s\S]*git push origin/);
  assert.match(workflow, /publish-npm:[\s\S]*needs: \[validate, create-tag\]/);
  assert.match(workflow, /publish-release:[\s\S]*needs: \[validate, create-tag, publish-npm, build-desktop\]/);
  assert.match(workflow, /client-breaking-removal[\s\S]*client-compat-removal-gate\.mjs/);
  assert.match(workflow, /gh release edit "\$TAG"[\s\S]*--notes-file release-notes\.md/);
  assert.match(workflow, /npm view "@rzx\/ohs@\$\{VERSION\}"/);
  assert.match(workflow, /name: client-release-evidence/);
});
