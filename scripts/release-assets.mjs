import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertArtifacts,
  normalizeStableReleaseNotes,
  renderStableReleaseNotes,
} from "./release-safety.mjs";

const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function expectedDesktopArtifacts(version) {
  if (!stableVersionPattern.test(version ?? "")) {
    throw new Error(`expected a stable X.Y.Z version, received ${String(version)}`);
  }
  return [
    `Vykor-${version}-setup.exe`,
    `Vykor-${version}.AppImage`,
    `Vykor-${version}.deb`,
    "latest.yml",
    "latest-linux.yml",
  ];
}

export function writeReleaseNotes(path, { version, commit }) {
  const artifacts = expectedDesktopArtifacts(version).slice(0, 3);
  writeFileSync(path, renderStableReleaseNotes({ version, commit, artifacts }));
}

export function assertArtifactFile(path, version) {
  const contents = readFileSync(path, "utf8").trim();
  const actual = contents ? contents.split(/\r?\n/) : [];
  return assertArtifacts(expectedDesktopArtifacts(version), actual);
}

function main() {
  const [command, path] = process.argv.slice(2);
  if (!path) throw new Error("usage: release-assets.mjs <write-notes|normalize-notes|assert-artifacts> <path>");
  if (command === "write-notes") {
    writeReleaseNotes(path, { version: process.env.VERSION, commit: process.env.COMMIT });
    return;
  }
  if (command === "normalize-notes") {
    writeFileSync(path, normalizeStableReleaseNotes(readFileSync(path, "utf8")));
    return;
  }
  if (command === "assert-artifacts") {
    assertArtifactFile(path, process.env.VERSION);
    return;
  }
  throw new Error(`unknown release asset command: ${String(command)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
