import { defineConfig } from "electron-vite"
import { resolve } from "node:path"
import react from "@vitejs/plugin-react"

const output = resolve("../../.superpowers/conversation-performance")
export default defineConfig({
  main: {
    build: {
      outDir: resolve(output, "main"),
      rollupOptions: {
        input: resolve("tests/conversation-performance/main.ts"),
        output: { entryFileNames: "main.cjs" },
      },
    },
  },
  renderer: {
    worker: { format: "es" },
    root: resolve("tests/conversation-performance"),
    plugins: [react()],
    resolve: {
      alias: { "@renderer": resolve("src/renderer/src"), "@shared": resolve("src/shared") },
    },
    build: {
      outDir: resolve(output, "renderer"),
      rollupOptions: {
        input: {
          host: resolve("tests/conversation-performance/host.html"),
          panels: resolve("tests/conversation-performance/panels.html"),
        },
      },
    },
  },
})
