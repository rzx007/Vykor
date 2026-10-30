import { build } from "esbuild";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";
import { readFile, readdir, rm, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = resolve(packageRoot, "..");
const dist = join(packageRoot, "dist");
if (dirname(dist) !== packageRoot) throw new Error("Unexpected client output directory");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// Resolve public workspace types to their original definitions, then inline them.
// Consumers install one SDK; no workspace package is a published dependency.
const paths = {};
const bundledPackages = new Map();
for (const directory of await readdir(packagesRoot)) {
  let manifest;
  try { manifest = JSON.parse(await readFile(join(packagesRoot, directory, "package.json"), "utf8")); }
  catch { continue; }
  for (const [subpath, entry] of Object.entries(manifest.exports ?? { ".": { import: manifest.main } })) {
    const source = typeof entry === "string" ? entry : entry.import ?? entry.types;
    if (source?.startsWith("./src/")) paths[manifest.name + subpath.slice(1)] = [join(packagesRoot, directory, source)];
  }
}

for (const [name, source, platform] of [
  ["index", "src/index.ts", "browser"],
  ["service", "src/service/index.ts", "node"],
]) {
  const result = await build({
    absWorkingDir: packageRoot, entryPoints: [source], outfile: `dist/${name}.js`,
    bundle: true, format: "esm", platform, target: "es2022", sourcemap: true, metafile: true,
    ...(platform === "node" ? {
      banner: { js: "import { createRequire as __sdkCreateRequire } from 'node:module'; const require = __sdkCreateRequire(import.meta.url);" },
    } : {}),
  });
  const bundled = await readFile(join(dist, `${name}.js`), "utf8");
  for (const output of Object.values(result.metafile.outputs)) {
    if (Object.entries(output.inputs).some(([file, value]) => value.bytesInOutput > 0 && /(?:application-client\/|client\/src\/(?:commands|resources\/(?:workspace|plugins))\/)/.test(file)))
      throw new Error(`${name}: application business code entered the SDK bundle`);
  }
  for (const input of Object.keys(result.metafile.inputs).filter(file => file.includes("node_modules"))) {
    let directory = dirname(resolve(packageRoot, input));
    while (dirname(directory) !== directory) {
      try {
        const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
        if (manifest.name) { bundledPackages.set(directory, manifest); break; }
      } catch {}
      directory = dirname(directory);
    }
  }
  if (/(?:from\s*|import\s*\()\s*["'](?:@vykor\/|@rzx\/client(?:\/|["']))/.test(bundled)) throw new Error(`${name}: unbundled workspace import`);
  if (name === "index" && Object.keys(result.metafile.inputs).some(file => /(?:server|services|core)\/src\//.test(file)))
    throw new Error("Browser client unexpectedly includes server execution code");
  const declarations = await rollup({
    input: join(packageRoot, source),
    external: id => id.startsWith("node:"),
    plugins: [dts({
      respectExternal: true, tsconfig: join(packageRoot, "tsconfig.json"),
      compilerOptions: { baseUrl: packageRoot, paths, declarationMap: false },
    })],
    onwarn(warning, warn) {
      if (warning.code === "UNRESOLVED_IMPORT") throw new Error(warning.message);
      warn(warning);
    },
  });
  try { await declarations.write({ file: join(dist, `${name}.d.ts`), format: "es" }); }
  finally { await declarations.close(); }
  const declaration = await readFile(join(dist, `${name}.d.ts`), "utf8");
  if (/\b(?:NoteRecord|ScheduledTaskRecord|MarketplaceCatalog|PluginAppConversationRequest|PluginAppRecord|PluginAppBackendDefinition|OfficePreview|ChannelStatusSnapshot|SessionCommandHost)\b/.test(declaration))
    throw new Error(`${name}: application business types entered SDK declarations`);
  if (/(?:from\s*|import\s*\()\s*["'](?:@vykor\/|@rzx\/client(?:\/|["']))/.test(declaration)) throw new Error(`${name}: public declarations leak workspace imports`);
  console.log(`Built ${name}.js and ${name}.d.ts (${platform})`);
}

// Preserve the license text for third-party code inlined into the Node entry.
const notices = [];
for (const [directory, manifest] of bundledPackages) {
  const licenses = (await readdir(directory)).filter(file => /^(?:licen[sc]e|copying)(?:\.|$)/i.test(file));
  if (!licenses.length) throw new Error(`Bundled dependency ${manifest.name} has no license file`);
  notices.push(`${manifest.name}@${manifest.version} (${manifest.license})\n\n${(await Promise.all(licenses.map(file => readFile(join(directory, file), "utf8")))).join("\n")}`);
}
if (notices.length) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dist, "THIRD_PARTY_NOTICES.txt"), notices.join("\n\n---\n\n"));
}
