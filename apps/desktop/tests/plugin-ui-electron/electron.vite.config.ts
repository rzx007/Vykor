import { defineConfig } from "electron-vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
const output = resolve("../../.superpowers/sdd/2026-10-03-native-plugin-ui-a3/electron-build");
export default defineConfig({
  main: { build: {
    outDir: resolve(output, "main"), emptyOutDir: true,
    externalizeDeps: { exclude: ["@vykor/client"] },
    rollupOptions: { input: resolve("tests/plugin-ui-electron/main.ts"), output: { entryFileNames: "main.cjs" } },
  } },
  preload: { build: {
    outDir: resolve(output, "preload"), emptyOutDir: true,
    externalizeDeps: { exclude: ["@electron-toolkit/preload"] },
    rollupOptions: { input: resolve("src/preload/index.ts"), output: { entryFileNames: "index.cjs" } },
  } },
  renderer: {
    root: ".",
    resolve: { alias: { "@renderer": resolve("src/renderer/src"), "@shared": resolve("src/shared") } },
    plugins: [react(), tailwindcss()],
    build: { outDir: resolve(output, "renderer"), emptyOutDir: true,
      rollupOptions: { input: resolve("tests/plugin-ui-electron/ui-host.html") } },
  },
});
