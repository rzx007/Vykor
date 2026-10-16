import { defineConfig } from "electron-vite"
import { resolve } from "node:path"
import react from "@vitejs/plugin-react"

const output = resolve("../../.superpowers/transcript-performance")
export default defineConfig({
  main: {
    build: {
      outDir: resolve(output, "main"),
      rollupOptions: {
        input: resolve("tests/transcript-performance/main.ts"),
        output: { entryFileNames: "main.cjs" },
      },
    },
  },
  renderer: {
    root: resolve("tests/transcript-performance"),
    plugins: [react()],
    resolve: {
      alias: { "@renderer": resolve("src/renderer/src"), "@shared": resolve("src/shared") },
    },
    build: {
      outDir: resolve(output, "renderer"),
      rollupOptions: { input: resolve("tests/transcript-performance/host.html") },
    },
  },
})
