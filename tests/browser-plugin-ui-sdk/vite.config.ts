import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: { alias: { "@vykor/plugins/ui-sdk": fileURLToPath(new URL("../../packages/plugins/src/ui-sdk.ts", import.meta.url)) } },
  plugins: [{
    name: "no-node-in-ui-sdk",
    generateBundle() {
      for (const id of this.getModuleIds()) {
        if (id.startsWith("node:") || id.includes("__vite-browser-external"))
          this.error("Plugin UI SDK must not depend on Node builtins");
      }
    },
  }],
  build: { outDir: "dist", emptyOutDir: true },
});
