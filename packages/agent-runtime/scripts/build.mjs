import { build } from "esbuild";
import { cp } from "node:fs/promises";

const shared = {
  bundle: true,
  // Native addons must resolve from their own package directories at runtime.
  external: ["node-pty", "sharp", "better-sqlite3"],
  platform: "node",
  target: "node20",
  logLevel: "info",
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ["src/index.ts"],
    outfile: "dist/index.js",
    format: "esm",
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  }),
  build({
    ...shared,
    entryPoints: ["src/kernel-entry.ts"],
    outfile: "dist/kernel.js",
    format: "esm",
  }),
]);

// Bundling moves NativeToolHost's import.meta.url beside dist/index.js.
await cp("src/native-tools/host-entry.mjs", "dist/host-entry.mjs");
