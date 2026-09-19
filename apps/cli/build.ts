/// <reference types="bun" />
import { cpSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const frontendPkg = JSON.parse(readFileSync("../frontend/package.json", "utf-8"));
const cliExternals = [...new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
  // Native addon: it must resolve beside the installed package, never from dist.
  "better-sqlite3",
  // Native addon: node-pty loads conpty.node from its own package directory.
  "node-pty",
  // Native addon: sharp loads @img/sharp-<platform> from its own package directory.
  "sharp",
])].filter((d) => !d.startsWith("@openharness/"));
const frontendExternals = [...new Set([
  ...Object.keys(frontendPkg.dependencies || {}),
  ...Object.keys(frontendPkg.peerDependencies || {}),
])].filter((d) => !d.startsWith("@openharness/"));

const cliResult = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  sourcemap: "external",
  external: cliExternals,
  plugins: [{
    name: "node-punycode-shim",
    setup(build) {
      build.onResolve({ filter: /^punycode$/ }, () => ({
        path: resolve("src/shims/punycode.cjs"),
      }));
    },
  }],
});

if (!cliResult.success) {
  console.error("CLI build failed:");
  for (const log of cliResult.logs) {
    console.error(log);
  }
  process.exit(1);
}

// OCR loads these from node_modules at runtime, so a missing install must fail
// the build rather than the first OCR call.
const distRequire = createRequire(pathToFileURL(resolve("dist/index.js")));
try {
  const lightOcrEntry = distRequire.resolve("@arcships/light-ocr");
  createRequire(lightOcrEntry).resolve(
    "@arcships/light-ocr-model-ppocrv6-small/bundle/manifest.json",
  );
} catch (error) {
  console.error(
    `CLI bundle cannot resolve the OCR runtime from dist: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

for (const output of cliResult.outputs) {
  if (output.path.endsWith("index.js")) {
    const content = "#!/usr/bin/env node\n" + await output.text();
    await Bun.write(output.path, content);
  }
}

rmSync("dist/frontend", { recursive: true, force: true });
const frontendResult = await Bun.build({
  entrypoints: ["../frontend/src/index.tsx"],
  outdir: "dist/frontend",
  target: "bun",
  format: "esm",
  sourcemap: "external",
  external: frontendExternals,
});

if (!frontendResult.success) {
  console.error("Frontend build failed:");
  for (const log of frontendResult.logs) {
    console.error(log);
  }
  process.exit(1);
}

for (const output of frontendResult.outputs) {
  if (output.path.endsWith("index.js")) {
    const content = "#!/usr/bin/env bun\n" + await output.text();
    await Bun.write(output.path, content);
  }
}

// Store migrations are runtime assets: source execution and the bundled CLI both
// resolve them next to the SessionStore module.
rmSync("dist/migrations", { recursive: true, force: true });
cpSync("../../packages/services/src/session-runtime/migrations", "dist/migrations", { recursive: true });

console.log(`Build complete: ${cliResult.outputs.length + frontendResult.outputs.length} files`);
