import { defineConfig } from "electron-vite"
import { resolve } from "node:path"
import { readFileSync } from "node:fs"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
const output = resolve(
  "../../.superpowers/sdd/2026-10-20-mcp-apps-resident-panels/electron-build"
)
export default defineConfig({
  main: {
    build: {
      outDir: resolve(output, "main"),
      emptyOutDir: true,
      externalizeDeps: { exclude: ["@rzx/client"] },
      rollupOptions: {
        input: resolve("tests/plugin-apps-electron/main.ts"),
        output: { entryFileNames: "main.cjs" },
      },
    },
  },
  preload: {
    build: {
      outDir: resolve(output, "preload"),
      emptyOutDir: true,
      externalizeDeps: { exclude: ["@electron-toolkit/preload"] },
      rollupOptions: {
        input: resolve("src/preload/index.ts"),
        output: { entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    root: ".",
    resolve: {
      alias: { "@renderer": resolve("src/renderer/src"), "@shared": resolve("src/shared") },
    },
    plugins: [react(), tailwindcss(), {
      name: "production-renderer-policy",
      transformIndexHtml(html) {
        // 直接使用正式桌面的加载规则，避免测试页放行而正式页面拦截应用。
        const production = readFileSync(resolve("src/renderer/index.html"), "utf8")
        const policy = production.match(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i)?.[0]
        if (!policy) throw new Error("Production renderer CSP is missing")
        return html.replace("<head>", `<head>${policy}`)
      },
    }],
    build: {
      outDir: resolve(output, "renderer"),
      emptyOutDir: true,
      rollupOptions: { input: {
        pluginApps: resolve("tests/plugin-apps-electron/plugin-app-host.html"),
        sdkHost: resolve("tests/plugin-apps-electron/host.html"),
      } },
    },
  },
})
