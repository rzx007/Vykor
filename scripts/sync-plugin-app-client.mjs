import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Keep standalone plugin sources portable without maintaining a second implementation.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "packages/plugins/src/app-client/client.ts");
const outputs = new Map();
const program = ts.createProgram([source], {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true,
  newLine: ts.NewLineKind.LineFeed,
  lib: ["lib.es2022.d.ts"], types: [], declaration: true, noEmitOnError: true,
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => "\n",
}));
program.emit(undefined, (file, text) => outputs.set(file.endsWith(".d.ts") ? "app-client.d.mts" : "app-client.mjs", text));
const folders = [
  "examples/plugins/text-inspector/ui", "examples/plugins/notes-app/ui",
  "skills/create-plugin/assets/text-inspector/ui", "skills/create-plugin/templates/weather-travel/ui",
];
const checking = process.argv.includes("--check");
for (const folder of folders) for (const [name, text] of outputs) {
  const file = resolve(root, folder, name);
  const content = "// Generated from packages/plugins/src/app-client/client.ts. Run node scripts/sync-plugin-app-client.mjs.\n" + text;
  if (checking) {
    const actual = await readFile(file, "utf8").catch(() => undefined);
    if (actual?.replace(/\r\n/g, "\n") !== content)
      throw new Error(`${folder}/${name} is stale; run node scripts/sync-plugin-app-client.mjs`);
  } else await writeFile(file, content);
}
console.log(`Plugin App client copies ${checking ? "checked" : "updated"} (${folders.length} standalone sources).`);
