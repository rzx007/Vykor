import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const externals = [
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
].filter((d) => !d.startsWith("@vykor/"));

const result = await Bun.build({
  entrypoints: ["src/index.tsx"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  sourcemap: "external",
  external: externals,
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

for (const output of result.outputs) {
  if (output.path.endsWith("index.js")) {
    const content = "#!/usr/bin/env bun\n" + await output.text();
    await Bun.write(output.path, content);
  }
}

console.log(`Build complete: ${result.outputs.length} files`);
