import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packagesDir = resolve(__dirname, "packages");
const aliases: Record<string, string> = {};

for (const name of readdirSync(packagesDir)) {
  const pkgDir = resolve(packagesDir, name);
  try {
    const raw = readFileSync(resolve(pkgDir, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as { name?: string };
    if (pkg.name?.startsWith("@vykor/")) {
      aliases[pkg.name] = resolve(pkgDir, "src", "index.ts");
    }
  } catch {
    // ignore non-package entries
  }
}

export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts", "packages/*/e2e/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: aliases,
  },
});
