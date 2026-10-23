import { defineConfig } from "vitest/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packagesDir = resolve(__dirname, "packages");
const aliases: Record<string, string> = {};

for (const name of readdirSync(packagesDir)) {
  const pkgDir = resolve(packagesDir, name);
  try {
    const raw = readFileSync(resolve(pkgDir, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    if (pkg.name?.startsWith("@vykor/")) {
      aliases[pkg.name] = resolve(pkgDir, "src", "index.ts");
      for (const [subpath, entry] of Object.entries(pkg.exports ?? {})) {
        if (subpath === ".") continue;
        const target = typeof entry === "string" ? entry : (entry as { import?: string }).import;
        if (target?.startsWith("./src/")) aliases[pkg.name + subpath.slice(1)] = resolve(pkgDir, target);
      }
    }
  } catch {}
}
aliases["@vykor/agent-runtime/kernel"] = resolve(packagesDir, "agent-runtime", "src", "kernel-entry.ts");
aliases["@vykor/agent-runtime/node/workflow"] = resolve(packagesDir, "agent-runtime", "src", "workflow-entry.ts");

aliases["@vykor/server/daemon-host"] = resolve(
  packagesDir,
  "server",
  "src",
  "daemon-host",
  "index.ts",
);

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    setupFiles: [resolve(__dirname, "tests/setup-isolated-host.ts")],
    maxWorkers: 2,
    // 不少测试会 spawn 真实子进程（bash/grep/glob、child agent 等），
    // 也有 zlib/CRC 压力归档、TypeScript 全量建程序这类重活。turbo 并行跑全量时
    // CPU 争抢会让这些用例慢数倍；5s 默认值、20s 都仍会在高负载下偶发超时
    // （非断言失败），这里再放宽到 60s 留足余量。
    testTimeout: 60000,
    hookTimeout: 60000,
  },
  resolve: {
    alias: Object.fromEntries(
      Object.entries(aliases).sort(([left], [right]) => right.length - left.length),
    ),
  },
});
