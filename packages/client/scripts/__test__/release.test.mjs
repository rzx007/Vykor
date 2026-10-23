import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { parseReleaseArgs, releaseClient } from "../release.mjs";

test("requires an explicit stable SDK version and preserves dry-run intent", () => {
  assert.deepEqual(parseReleaseArgs(["--", "--dry-run", "0.2.0"]), { version: "0.2.0", dryRun: true });
  for (const args of [[], ["patch"], ["1.2.3-beta.1"], ["1.2.3", "extra"], ["--skip-build", "1.2.3"], ["01.2.3"]])
    assert.throws(() => parseReleaseArgs(args), /version|argument|Usage/i);
});

test("verifies the candidate package before dry-run publishing and restores the manifest", () => {
  const directory = mkdtempSync(join(tmpdir(), "vykor-sdk-release-"));
  assert.equal(dirname(directory), resolve(tmpdir()));
  const file = join(directory, "package.json");
  const original = '{ "name": "@rzx/client", "version": "0.1.0" }\n';
  writeFileSync(file, original);
  const calls = [];
  try {
    releaseClient(["--dry-run", "0.2.0"], { directory, run(args) {
      assert.equal(JSON.parse(readFileSync(file, "utf8")).version, "0.2.0");
      calls.push(args);
    } });
    assert.deepEqual(calls, [
      ["run", "verify:pack"],
      ["publish", "--access", "public", "--no-git-checks", "--ignore-scripts", "--dry-run"],
    ]);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.throws(() => releaseClient(["0.2.0"], { directory, run() { throw new Error("verification failed"); } }), /verification failed/);
    assert.equal(readFileSync(file, "utf8"), original);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
