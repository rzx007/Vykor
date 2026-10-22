import { build } from "esbuild";
import { cp, readdir, readFile } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";

function verifyKernelInputs(metafile) {
  const forbidden = Object.keys(metafile.inputs).filter((path) => {
    const normalized = path.replaceAll("\\", "/");
    return (
      /(?:^src\/node\/|agent-runtime\/src\/node\/)/.test(normalized) ||
      /(?:^|\/)(host-config|tools|plugins|coordinator|protocol|services|server|execution-node|api|auth|hooks|mcp|memory|sandbox|skills|terminal-node|terminal|jobs)\/src\//.test(
        normalized,
      )
    );
  });
  if (forbidden.length)
    throw new Error(
      `Kernel bundle reaches Node host modules:\n${forbidden.join("\n")}`,
    );
}

async function verifyKernelDeclarations() {
  const kernel = resolve("dist/kernel");
  const files = [
    resolve("dist/kernel-entry.d.ts"),
    ...(await readdir(kernel))
      .filter((name) => name.endsWith(".d.ts"))
      .map((name) => resolve(kernel, name)),
  ];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (/\bNodeJS\./.test(source))
      throw new Error(
        `Kernel declaration reaches Node-specific types: ${file}`,
      );
    for (const match of source.matchAll(
      /(?:from\s*|import\s*\()\s*["']([^"']+)["']/g,
    )) {
      const name = match[1];
      if (
        [
          "@vykor/agent-contracts",
          "@vykor/core/engine",
          "@vykor/environment",
        ].includes(name)
      )
        continue;
      if (
        name.startsWith(".") &&
        !relative(kernel, resolve(dirname(file), name)).startsWith("..")
      )
        continue;
      throw new Error(
        `Kernel declaration reaches a host dependency: ${file} -> ${name}`,
      );
    }
  }
}
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
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  }),
  build({
    ...shared,
    entryPoints: ["src/kernel-entry.ts"],
    outfile: "dist/kernel.js",
    format: "esm",
    metafile: true,
  }).then((result) => {
    verifyKernelInputs(result.metafile);
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
