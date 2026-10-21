import { build } from "esbuild"
import { cp, copyFile, mkdir } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const output = join(
  root,
  ".superpowers/sdd/2026-10-20-mcp-apps-resident-panels/electron-build/backend"
)

// 与 CLI bundle 使用相同的旁置资源约定：迁移文件和原生工具的独立进程入口。
await mkdir(output, { recursive: true })
await Promise.all([
  cp(join(root, "packages/services/src/session-runtime/migrations"), join(output, "migrations"), {
    recursive: true,
  }),
  copyFile(
    join(root, "packages/agent-runtime/src/native-tools/host-entry.mjs"),
    join(output, "host-entry.mjs")
  ),
])
console.log("Plugin Apps test backend built")

// Exercise the actual official browser SDK offline in the production document sandbox.
await build({
  entryPoints: [join(root, "apps/desktop/tests/plugin-apps-electron/mcp-apps-sdk-fixture.ts")],
  outfile: join(output, "../mcp-apps-sdk-fixture.js"),
  bundle: true,
  platform: "browser",
  target: "chrome142",
  format: "iife",
})

await build({
  entryPoints: [join(root, "packages/server/test-helpers/plugin-app-electron.mts")],
  outfile: join(output, "plugin-app-backend.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: {
    js: "import {createRequire as __nativeTestCreateRequire} from 'node:module'; const require = __nativeTestCreateRequire(import.meta.url);",
  },
  logOverride: { "equals-negative-zero": "silent" },
  plugins: [
    {
      name: "native-test-dependencies",
      setup(build) {
        // 始终测当前源码，避免依赖工作区上次留下的 dist 产物。
        build.onResolve({ filter: /^@vykor\/agent-runtime$/ }, () => ({
          path: join(root, "packages/agent-runtime/src/index.ts"),
        }))
        build.onResolve({ filter: /^(better-sqlite3|node-pty|sharp)(\/.*)?$/ }, (args) => {
          const resolved = require.resolve(args.path, { paths: [args.resolveDir] })
          return {
            path: args.kind === "require-call" ? resolved : pathToFileURL(resolved).href,
            external: true,
          }
        })
      },
    },
  ],
})
await build({
  entryPoints: [join(root, "apps/desktop/tests/plugin-apps-electron/plugin-app-page.ts")],
  outfile: join(output, "../plugin-app-page.js"), bundle: true, platform: "browser", target: "chrome142", format: "iife",
})
