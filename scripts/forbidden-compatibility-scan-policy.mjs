import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const forbiddenScanRoots = Object.freeze([
  "packages", "apps", "scripts", "tests", "docs", ".github", "package.json",
]);

export const forbiddenScanDefaultAllow = Object.freeze([
  "scripts/forbidden-compatibility-surfaces.json",
  "scripts/forbidden-compatibility-surfaces.test.mjs",
  "scripts/verify-clean-slate.test.mjs",
  "tests/client-public-api/consumer.ts",
  "apps/cli/src/index.test.ts",
  "packages/plugins/src/installation/store.test.ts",
  "packages/plugins/src/manifest/schema-v1.test.ts",
  "packages/protocol/src/terminal.type-test.ts",
  "packages/server/src/http/routes/terminal.test.ts",
  "packages/skills/src/index.test.ts",
  "docs/compatibility-surface-audit.md",
  "docs/plans/",
  "docs/superpowers/plans/",
  "docs/superpowers/specs/",
]);

const scannedExtension = /\.(?:c?js|mjs|json|md|sql|ts|tsx|ya?ml)$/i;
const excludedDirectories = new Set(["node_modules", "dist", ".git", ".turbo"]);

export function normalizeForbiddenScanPath(path) {
  return path.replaceAll("\\", "/");
}

function collectDirectory(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      return excludedDirectories.has(entry.name) ? [] : collectDirectory(child);
    }
    return scannedExtension.test(entry.name) ? [child] : [];
  });
}

export function collectForbiddenScanFiles(cwd, roots = forbiddenScanRoots) {
  const base = resolve(cwd);
  return roots.flatMap((root) => {
    const path = resolve(base, root);
    if (!existsSync(path)) return [];
    return scannedExtension.test(path) ? [path] : collectDirectory(path);
  });
}

export function createForbiddenScanAllow(additional = []) {
  return [...forbiddenScanDefaultAllow, ...additional].map(normalizeForbiddenScanPath);
}

export function isForbiddenScanAllowed(cwd, file, allow) {
  const rel = normalizeForbiddenScanPath(relative(resolve(cwd), file));
  return allow.some((item) => item.endsWith("/") ? rel.startsWith(item) : rel === item);
}
