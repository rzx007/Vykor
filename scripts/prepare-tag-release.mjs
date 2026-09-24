import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TAG_RELEASE_PATTERN = /^v(\d+\.\d+\.\d+)$/;
const SEMVER_CORE_PART_PATTERN = /^(0|[1-9]\d*)$/;

export class ReleaseTagError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseTagError";
  }
}

export class ReleaseManifestMismatchError extends Error {
  constructor(mismatches) {
    super(mismatches.map(formatMismatch).join("\n"));
    this.name = "ReleaseManifestMismatchError";
    this.mismatches = mismatches;
  }
}

function formatMismatch(mismatch) {
  return `${mismatch.manifest}: expected version ${mismatch.expected}, found ${JSON.stringify(mismatch.actual)}`;
}

function assertSemverCore(version) {
  for (const part of version.split(".")) {
    if (!SEMVER_CORE_PART_PATTERN.test(part)) {
      throw new ReleaseTagError(
        `Invalid release tag: expected strict vX.Y.Z format, received ${JSON.stringify(`v${version}`)}`,
      );
    }
  }
}

export function parseReleaseTag(tag) {
  if (typeof tag !== "string") {
    throw new ReleaseTagError(
      `Invalid release tag: expected strict vX.Y.Z format, received ${JSON.stringify(tag)}`,
    );
  }

  const match = TAG_RELEASE_PATTERN.exec(tag);
  if (!match) {
    throw new ReleaseTagError(
      `Invalid release tag: expected strict vX.Y.Z format, received ${JSON.stringify(tag)}`,
    );
  }

  const version = match[1];
  assertSemverCore(version);
  return version;
}

export function resolveReleaseRoot(root = process.env.VYKOR_TAG_RELEASE_ROOT) {
  if (root) return resolve(root);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function resolveManifestPaths(root = resolveReleaseRoot()) {
  return {
    workspace: join(root, "package.json"),
    desktop: join(root, "apps/desktop/package.json"),
    cli: join(root, "apps/cli/package.json"),
  };
}

function readManifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readManifestVersion(path) {
  return readManifest(path).version;
}

export function setManifestVersion(path, version) {
  const manifest = readManifest(path);
  manifest.version = version;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function validateManifestVersions({ tag, rootVersion, desktopVersion, cliVersion }) {
  const expected = parseReleaseTag(tag);
  const mismatches = [];

  if (rootVersion !== expected) {
    mismatches.push({
      manifest: "package.json",
      expected,
      actual: rootVersion,
    });
  }

  if (desktopVersion !== expected) {
    mismatches.push({
      manifest: "apps/desktop/package.json",
      expected,
      actual: desktopVersion,
    });
  }

  if (cliVersion !== expected) {
    mismatches.push({
      manifest: "apps/cli/package.json",
      expected,
      actual: cliVersion,
    });
  }

  return mismatches;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

export function prepareTagRelease({ tag, root = resolveReleaseRoot(), checkOnly = false }) {
  const version = parseReleaseTag(tag);
  const manifests = resolveManifestPaths(root);
  const rootVersion = readManifestVersion(manifests.workspace);
  const desktopVersion = readManifestVersion(manifests.desktop);
  const cliVersion = readManifestVersion(manifests.cli);

  if (checkOnly) {
    const mismatches = validateManifestVersions({
      tag,
      rootVersion,
      desktopVersion,
      cliVersion,
    });
    if (mismatches.length > 0) {
      throw new ReleaseManifestMismatchError(mismatches);
    }
    return { tag, version, checkOnly: true };
  }

  setManifestVersion(manifests.workspace, version);
  setManifestVersion(manifests.desktop, version);
  setManifestVersion(manifests.cli, version);
  return { tag, version, checkOnly: false };
}

function parseArgs(argv) {
  const args = [...argv];
  const checkOnly = args[0] === "--check";
  if (checkOnly) args.shift();
  const tag = args[0];

  if (!tag || args.length > 1) {
    fail("Usage: node scripts/prepare-tag-release.mjs [--check] <vX.Y.Z>");
  }

  return { tag, checkOnly };
}

function main() {
  const { tag, checkOnly } = parseArgs(process.argv.slice(2));

  try {
    const result = prepareTagRelease({ tag, checkOnly });
    if (checkOnly) {
      console.log(`Tag release check ok: ${result.tag} -> ${result.version}`);
    } else {
      console.log(`Tag release prepared: ${result.tag} -> ${result.version}`);
    }
  } catch (error) {
    if (error instanceof ReleaseTagError || error instanceof ReleaseManifestMismatchError) {
      fail(error.message);
    }
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
