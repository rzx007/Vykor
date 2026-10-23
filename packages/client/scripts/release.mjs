import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = "Usage: pnpm release:client[:dry] -- <x.y.z>";

export function parseReleaseArgs(args) {
  let version;
  let dryRun = false;
  for (const arg of args) {
    if (arg === "--") continue;
    if (arg === "--dry-run") { dryRun = true; continue; }
    if (version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(arg))
      throw new Error(`Invalid version or argument. ${usage}`);
    version = arg;
  }
  if (!version) throw new Error(`An explicit version is required. ${usage}`);
  return { version, dryRun };
}

/** The runner boundary keeps release sequencing testable without uploading packages. */
export function releaseClient(args, { directory = packageRoot, run = runPnpm } = {}) {
  const options = parseReleaseArgs(args);
  const file = join(directory, "package.json");
  const original = readFileSync(file, "utf8");
  const manifest = JSON.parse(original);
  if (manifest.name !== "@vykor/client") throw new Error("SDK release directory is not @vykor/client");
  try {
    writeFileSync(file, JSON.stringify({ ...manifest, version: options.version }, null, 2) + "\n");
    // pack runs prepack/build, then installs and verifies this exact candidate.
    run(["run", "verify:pack"], directory);
    run([
      "publish", "--access", "public", "--no-git-checks", "--ignore-scripts",
      ...(options.dryRun ? ["--dry-run"] : []),
    ], directory);
  } finally { writeFileSync(file, original); }
}

function runPnpm(args, cwd) {
  const cli = process.env.npm_execpath;
  if (!cli) throw new Error("Run SDK release through pnpm");
  execFileSync(process.execPath, [cli, ...args], { cwd, stdio: "inherit" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { releaseClient(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
