import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assertArtifacts,
  assertReleaseCommit,
  assertTagAvailable,
  decideNpmPublish,
  renderStableReleaseNotes,
} from "./release-safety.mjs";

const sha = "a".repeat(40);

test("release commit must be one fixed full SHA", () => {
  assert.equal(assertReleaseCommit({ requestedSha: sha.toUpperCase(), checkedOutSha: sha }), sha);
  assert.throws(() => assertReleaseCommit({ requestedSha: "main", checkedOutSha: sha }), /full Git SHA/);
  assert.throws(() => assertReleaseCommit({ requestedSha: sha, checkedOutSha: "b".repeat(40) }), /checked out/);
});

test("an existing tag is reusable only at the same commit", () => {
  assert.equal(assertTagAvailable({ tag: "v1.2.3", targetSha: sha, existingSha: undefined }), "create");
  assert.equal(assertTagAvailable({ tag: "v1.2.3", targetSha: sha, existingSha: sha }), "reuse");
  assert.throws(
    () => assertTagAvailable({ tag: "v1.2.3", targetSha: sha, existingSha: "b".repeat(40) }),
    /already points/,
  );
});

test("npm publication is idempotent but never accepts a different version", () => {
  assert.equal(decideNpmPublish({ expectedVersion: "1.2.3", publishedVersion: undefined }), "publish");
  assert.equal(decideNpmPublish({ expectedVersion: "1.2.3", publishedVersion: "1.2.3" }), "skip");
  assert.throws(
    () => decideNpmPublish({ expectedVersion: "1.2.3", publishedVersion: "1.2.2" }),
    /expected 1.2.3/,
  );
});

test("release artifacts must contain every expected file", () => {
  assert.deepEqual(
    assertArtifacts(["OpenHarness-1.2.3-setup.exe", "OpenHarness-1.2.3.AppImage"], [
      "OpenHarness-1.2.3.AppImage",
      "OpenHarness-1.2.3-setup.exe",
      "latest.yml",
    ]),
    ["OpenHarness-1.2.3-setup.exe", "OpenHarness-1.2.3.AppImage"],
  );
  assert.throws(() => assertArtifacts(["app.exe", "app.deb"], ["app.exe"]), /app.deb/);
});

test("stable release notes contain immutable release identity and artifacts", () => {
  const notes = renderStableReleaseNotes({
    version: "1.2.3",
    commit: sha,
    artifacts: ["OpenHarness-1.2.3-setup.exe", "OpenHarness-1.2.3.AppImage"],
  });
  assert.match(notes, /OpenHarness 1\.2\.3/);
  assert.match(notes, new RegExp(sha));
  assert.match(notes, /OpenHarness-1\.2\.3-setup\.exe/);
  assert.doesNotMatch(notes, /compatibility|deprecation|retention|breaking removal/i);
});

test("release asset CLI preserves the version in notes and artifact validation", () => {
  const cwd = mkdtempSync(join(tmpdir(), "openharness-release-assets-"));
  const script = fileURLToPath(new URL("./release-assets.mjs", import.meta.url));
  const notes = join(cwd, "release-notes.md");
  const artifacts = join(cwd, "artifact-names.txt");
  const env = { ...process.env, VERSION: "1.2.3", COMMIT: "a".repeat(40) };
  try {
    execFileSync(process.execPath, [script, "write-notes", notes], { cwd, env, stdio: "pipe" });
    assert.match(readFileSync(notes, "utf8"), /OpenHarness-1\.2\.3-setup\.exe/);
    assert.match(readFileSync(notes, "utf8"), /OpenHarness-1\.2\.3\.AppImage/);
    assert.match(readFileSync(notes, "utf8"), /OpenHarness-1\.2\.3\.deb/);

    writeFileSync(
      artifacts,
      "OpenHarness-1.2.3-setup.exe\nOpenHarness-1.2.3.AppImage\nOpenHarness-1.2.3.deb\nlatest.yml\nlatest-linux.yml\n",
    );
    execFileSync(process.execPath, [script, "assert-artifacts", artifacts], { cwd, env, stdio: "pipe" });

    writeFileSync(artifacts, "OpenHarness--setup.exe\nOpenHarness-.AppImage\nOpenHarness-.deb\nlatest.yml\nlatest-linux.yml\n");
    assert.throws(
      () => execFileSync(process.execPath, [script, "assert-artifacts", artifacts], { cwd, env, stdio: "pipe" }),
      /Command failed/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workflow preserves build, publication, verification and rerun ordering", () => {
  const workflow = readFileSync(new URL("../.github/workflows/tag-release.yml", import.meta.url), "utf8");
  const attributes = readFileSync(new URL("../.gitattributes", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /release_phase|client-compat|compatibility lifecycle/i);
  assert.match(attributes, /^packages\/services\/src\/session-runtime\/migrations\/\*\* text eol=lf$/m);
  assert.match(workflow, /ref:\s*\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /build-desktop:[\s\S]*verify-clean-slate-artifacts:[\s\S]*create-tag:/);
  assert.match(workflow, /verify-clean-slate-artifacts:[\s\S]*needs: \[validate, preflight, build-desktop\]/);
  assert.match(workflow, /verify-clean-slate-artifacts:[\s\S]*pattern: desktop-\*[\s\S]*merge-multiple: true[\s\S]*pnpm --filter @rzx\/ohs\.\.\. build[\s\S]*pnpm --filter @openharness\/desktop build[\s\S]*pnpm check:clean-slate:artifacts/);
  assert.match(workflow, /build-desktop:[\s\S]*verify-migration-artifact\.mjs --write-inventory \$\{\{ matrix\.target \}\}[\s\S]*clean-slate-migrations-\*\.json/);
  assert.match(workflow, /verify-clean-slate-artifacts:[\s\S]*verify-migration-artifact\.mjs[\s\S]*--verify-inventories[\s\S]*clean-slate-migrations-win\.json[\s\S]*clean-slate-migrations-linux\.json/);
  assert.match(workflow, /--verify-inventories[\s\S]*\$\{\{ github\.workspace \}\}\/release-assets\/clean-slate-migrations-win\.json[\s\S]*\$\{\{ github\.workspace \}\}\/release-assets\/clean-slate-migrations-linux\.json/);
  assert.match(workflow, /create-tag:[\s\S]*needs: \[validate, preflight, build-desktop, verify-clean-slate-artifacts\]/);
  assert.match(workflow, /publish-npm:[\s\S]*npm view "@rzx\/ohs@\$\{VERSION\}"/);
  assert.match(workflow, /publish-npm:[\s\S]*for attempt in \$\(seq 1 12\)[\s\S]*npm view "@rzx\/ohs@\$\{VERSION\}" version/);
  assert.match(workflow, /publish-npm:[\s\S]*pnpm --filter @rzx\/ohs publish[\s\S]*for attempt in \$\(seq 1 12\)[\s\S]*test "\$ACTUAL" = "\$VERSION"/);
  assert.match(workflow, /publish-release:[\s\S]*needs: \[validate, create-tag, publish-npm, build-desktop\]/);
  assert.match(workflow, /gh release upload "\$TAG"[\s\S]*--clobber/);
  assert.match(workflow, /gh release edit "\$TAG"[\s\S]*--notes-file release-notes\.md/);
  assert.match(workflow, /gh release view "\$TAG" --json body/);
  assert.match(workflow, /gh release view "\$TAG" --json assets/);
  assert.match(workflow, /notify:[\s\S]*if: always\(\)/);
  assert.match(workflow, /notify:[\s\S]*needs: \[[^\]]*verify-clean-slate-artifacts[^\]]*\]/);
  assert.deepEqual(
    [...workflow.matchAll(/node scripts\/release-assets\.mjs (write-notes|assert-artifacts)/g)].map((match) => match[1]),
    ["write-notes", "assert-artifacts", "assert-artifacts", "assert-artifacts"],
  );
  assert.doesNotMatch(workflow, /\$\{v\}/);
});
