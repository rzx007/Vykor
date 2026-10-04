import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: { alias: { "@vykor/client": fileURLToPath(new URL("../../packages/client/src/index.ts", import.meta.url)) } },
  build: { outDir: "dist", emptyOutDir: true },
});
