const fullCommitPattern = /^[0-9a-f]{40}$/i;
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function requireFullSha(value, label) {
  if (!fullCommitPattern.test(value ?? "")) {
    throw new Error(`${label} must be a full Git SHA`);
  }
  return value.toLowerCase();
}

function requireStableVersion(value) {
  if (!stableVersionPattern.test(value ?? "")) {
    throw new Error(`expected a stable X.Y.Z version, received ${String(value)}`);
  }
  return value;
}

export function assertReleaseCommit({ requestedSha, checkedOutSha }) {
  const requested = requireFullSha(requestedSha, "requestedSha");
  const checkedOut = requireFullSha(checkedOutSha, "checkedOutSha");
  if (requested !== checkedOut) {
    throw new Error(`checked out commit ${checkedOut} does not match requested release commit ${requested}`);
  }
  return requested;
}

export function assertTagAvailable({ tag, targetSha, existingSha }) {
  const target = requireFullSha(targetSha, "targetSha");
  if (!existingSha) return "create";
  const existing = requireFullSha(existingSha, "existingSha");
  if (existing !== target) {
    throw new Error(`${tag} already points to ${existing}, expected ${target}`);
  }
  return "reuse";
}

export function decideNpmPublish({ expectedVersion, publishedVersion }) {
  const expected = requireStableVersion(expectedVersion);
  if (publishedVersion === undefined || publishedVersion === null || publishedVersion === "") {
    return "publish";
  }
  if (publishedVersion !== expected) {
    throw new Error(`npm published version ${publishedVersion} does not match expected ${expected}`);
  }
  return "skip";
}

export function assertArtifacts(expectedNames, actualNames) {
  const actual = new Set(actualNames);
  const missing = expectedNames.filter((name) => !actual.has(name));
  if (missing.length > 0) throw new Error(`missing release artifacts: ${missing.join(", ")}`);
  return expectedNames;
}

export function renderStableReleaseNotes({ version, commit, artifacts }) {
  const stableVersion = requireStableVersion(version);
  const releaseCommit = requireFullSha(commit, "commit");
  const names = [...artifacts];
  if (names.length === 0) throw new Error("release notes require at least one artifact");
  return [
    `# OpenHarness ${stableVersion}`,
    "",
    `Commit: \`${releaseCommit}\``,
    "",
    "## Desktop artifacts",
    ...names.map((name) => `- \`${name}\``),
    "",
    "## CLI",
    "```bash",
    `npm install -g @rzx/ohs@${stableVersion}`,
    "```",
    "",
  ].join("\n");
}

export function normalizeStableReleaseNotes(notes) {
  return `${String(notes).replace(/\s+$/u, "")}\n`;
}
