import { defineConfig } from "electron-vite"
import { resolve } from "node:path"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { browserAnnotationSelectorPlugin } from "../../scripts/browser-annotation-selector-plugin"

export default defineConfig({
  main: {
    plugins: [browserAnnotationSelectorPlugin()],
    resolve: { alias: { "@main": resolve("src/main"), "@shared": resolve("src/shared") } },
    build: {
      outDir: resolve("../../.superpowers/browser-annotations/main"),
      rollupOptions: {
        input: resolve("tests/browser-annotations-electron/main.ts"),
        output: { entryFileNames: "main.cjs" },
      },
    },
  },
  preload: {
    build: {
      outDir: resolve("../../.superpowers/browser-annotations/preload"),
      rollupOptions: {
        input: resolve("tests/browser-annotations-electron/preload.ts"),
        output: { entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    root: resolve("tests/browser-annotations-electron"),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@renderer": resolve("src/renderer/src"), "@shared": resolve("src/shared") },
    },
    build: {
      outDir: resolve("../../.superpowers/browser-annotations/renderer"),
      rollupOptions: {
        input: {
          host: resolve("tests/browser-annotations-electron/host.html"),
          ui: resolve("tests/browser-annotations-electron/ui-host.html"),
          page: resolve("tests/browser-annotations-electron/react-page.html"),
        },
      },
    },
  },
})
