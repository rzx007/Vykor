import { copyFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// The standalone plugin receives this module during packaging. Source-checkout
// tests need the same copy, but do not need to download an OfficeCLI binary.
await copyFile(
  join(root, "packages/services/src/office/office-engine.mjs"),
  join(root, "plugins/office-work/tools/office-engine.mjs"),
);

const args = ["--test", "--test-concurrency=2"];
if (process.platform !== "win32" || process.arch !== "x64") {
  // Only the real engine integration is Windows-only; runner/cleanup tests
  // still execute on Linux using Node as their subprocess fixture.
  args.push("--test-skip-pattern=^real OfficeCLI:");
}
args.push("plugins/*/test/*.test.mjs");
const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
