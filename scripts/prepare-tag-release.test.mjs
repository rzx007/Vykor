import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseReleaseTag,
  prepareTagRelease,
  ReleaseManifestMismatchError,
  ReleaseTagError,
  readManifestVersion,
  setManifestVersion,
  validateManifestVersions,
} from "./prepare-tag-release.mjs";

const scriptPath = fileURLToPath(new URL("./prepare-tag-release.mjs", import.meta.url));

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "prepare-tag-release-"));
  const rootPath = join(root, "package.json");
  const desktopPath = join(root, "apps", "desktop", "package.json");
  const cliPath = join(root, "apps", "cli", "package.json");

  mkdirSync(join(root, "apps", "desktop"), { recursive: true });
  mkdirSync(join(root, "apps", "cli"), { recursive: true });
  writeFileSync(
    rootPath,
    `${JSON.stringify({ name: "vykor", private: true, version: "0.0.0" }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    desktopPath,
    `${JSON.stringify({ name: "@vykor/desktop", version: "0.0.0" }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    cliPath,
    `${JSON.stringify({ name: "@rzx/ohs", version: "0.0.0", repository: { type: "git" } }, null, 2)}\n`,
    "utf8",
  );

  return { root, rootPath, desktopPath, cliPath };
}

function runCli(args, root) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      VYKOR_TAG_RELEASE_ROOT: root,
    },
  });
}

test("parseReleaseTag accepts strict vX.Y.Z and returns X.Y.Z", () => {
  assert.equal(parseReleaseTag("v1.0.1"), "1.0.1");
  assert.equal(parseReleaseTag("v10.20.300"), "10.20.300");
});

test("parseReleaseTag rejects invalid tag formats", () => {
  const invalidTags = [
    "1.0.1",
    "v1.0",
    "v1.0.1-beta.1",
    "v1.0.1; rm -rf /",
    "../../../etc/passwd",
    "v1.0.1\n",
    " v1.0.1",
    "v1.0.1 ",
    "v1.0.1$(whoami)",
    "v1.0.1|cat /etc/passwd",
  ];

  for (const tag of invalidTags) {
    assert.throws(() => parseReleaseTag(tag), ReleaseTagError);
  }
});

test("parseReleaseTag rejects semver core leading zeros", () => {
  const invalidTags = ["v01.2.3", "v1.02.3", "v1.2.03", "v00.0.0"];

  for (const tag of invalidTags) {
    assert.throws(() => parseReleaseTag(tag), ReleaseTagError);
  }
});

test("prepareTagRelease checkOnly throws structured mismatch error", () => {
  const { root, rootPath, desktopPath, cliPath } = createFixture();

  try {
    setManifestVersion(rootPath, "1.0.1");
    setManifestVersion(cliPath, "1.0.1");
    setManifestVersion(desktopPath, "9.9.9");

    assert.throws(
      () => prepareTagRelease({ tag: "v1.0.1", root, checkOnly: true }),
      (error) => {
        assert.ok(error instanceof ReleaseManifestMismatchError);
        assert.ok(error.mismatches.length >= 1);
        assert.equal(error.mismatches[0].manifest, "apps/desktop/package.json");
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setManifestVersion writes version while preserving other manifest fields", () => {
  const { root, rootPath, desktopPath, cliPath } = createFixture();

  try {
    setManifestVersion(rootPath, "1.0.1");
    setManifestVersion(desktopPath, "1.0.1");
    setManifestVersion(cliPath, "1.0.1");

    const workspace = JSON.parse(readFileSync(rootPath, "utf8"));
    const desktop = JSON.parse(readFileSync(desktopPath, "utf8"));
    const cli = JSON.parse(readFileSync(cliPath, "utf8"));

    assert.equal(workspace.version, "1.0.1");
    assert.equal(workspace.name, "vykor");
    assert.equal(workspace.private, true);
    assert.equal(desktop.version, "1.0.1");
    assert.equal(desktop.name, "@vykor/desktop");
    assert.equal(cli.version, "1.0.1");
    assert.equal(cli.name, "@rzx/ohs");
    assert.deepEqual(cli.repository, { type: "git" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateManifestVersions reports mismatched manifests", () => {
  const mismatches = validateManifestVersions({
    tag: "v1.0.1",
    rootVersion: "1.0.1",
    desktopVersion: "1.0.0",
    cliVersion: "1.0.1",
  });

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].manifest, "apps/desktop/package.json");
  assert.equal(mismatches[0].expected, "1.0.1");
  assert.equal(mismatches[0].actual, "1.0.0");
});

test("CLI write mode updates root, Desktop, and CLI manifests for a valid tag", () => {
  const { root, rootPath, desktopPath, cliPath } = createFixture();

  try {
    const result = runCli(["v1.0.1"], root);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    assert.equal(readManifestVersion(rootPath), "1.0.1");
    assert.equal(readManifestVersion(desktopPath), "1.0.1");
    assert.equal(readManifestVersion(cliPath), "1.0.1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI check mode does not modify manifests", () => {
  const { root, rootPath, desktopPath, cliPath } = createFixture();

  try {
    setManifestVersion(rootPath, "1.0.1");
    setManifestVersion(desktopPath, "1.0.1");
    setManifestVersion(cliPath, "1.0.1");
    const rootPrepared = readFileSync(rootPath, "utf8");
    const desktopPrepared = readFileSync(desktopPath, "utf8");
    const cliPrepared = readFileSync(cliPath, "utf8");

    const result = runCli(["--check", "v1.0.1"], root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(rootPath, "utf8"), rootPrepared);
    assert.equal(readFileSync(desktopPath, "utf8"), desktopPrepared);
    assert.equal(readFileSync(cliPath, "utf8"), cliPrepared);

    setManifestVersion(desktopPath, "9.9.9");
    const desktopMismatch = readFileSync(desktopPath, "utf8");
    const rootStillPrepared = readFileSync(rootPath, "utf8");
    const cliStillPrepared = readFileSync(cliPath, "utf8");

    const failing = runCli(["--check", "v1.0.1"], root);
    assert.notEqual(failing.status, 0);
    assert.match(failing.stderr, /apps\/desktop\/package\.json/);
    assert.equal(readFileSync(rootPath, "utf8"), rootStillPrepared);
    assert.equal(readFileSync(desktopPath, "utf8"), desktopMismatch);
    assert.equal(readFileSync(cliPath, "utf8"), cliStillPrepared);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI rejects invalid tags before touching manifests", () => {
  const { root, desktopPath } = createFixture();
  const before = readFileSync(desktopPath, "utf8");

  try {
    const result = runCli(["1.0.1"], root);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(desktopPath, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
