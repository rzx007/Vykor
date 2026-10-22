import { build } from "esbuild";
import { cp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { verifyKernelInputs, verifyKernelDeclarations } from "./kernel-boundary.mjs";

await verifyKernelDeclarations();

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
    metafile: true,
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  }).then(async (result) => {
    await writeFile("dist/default.metafile.json", JSON.stringify(result.metafile, null, 2));
    return result;
  }),
  build({
    ...shared,
    entryPoints: ["src/kernel-entry.ts"],
    outfile: "dist/kernel.js",
    format: "esm",
    metafile: true,
  }).then(async (result) => {
    verifyKernelInputs(result.metafile);
    await writeFile("dist/kernel.metafile.json", JSON.stringify(result.metafile, null, 2));
    return result;
  }),
  build({
    ...shared,
    entryPoints: ["src/workflow-entry.ts"],
    outfile: "dist/workflow.js",
    format: "esm",
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  }),
]);

// Bundling moves NativeToolHost's import.meta.url beside dist/index.js.
await cp("src/node/plugins/native-tools/host-entry.mjs", "dist/host-entry.mjs");
